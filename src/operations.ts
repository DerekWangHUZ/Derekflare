import { audit, lock, unlock } from './db';
import { createRecord, deleteRecord, listRecords, purgeHost, updateRecord } from './cloudflare';
import { normalizeName, ownerFor, scopesFor, under, validatePayload, zoneFor, mayWrite, mayView } from './policy';
import { AppError, id, now, type Actor, type DnsRecord, type Env, type Policy, type Zone } from './types';

export type ChangeKind = 'create' | 'update' | 'delete';

async function ownerMap(env: Env, zone: string) {
  const rows = await env.DB.prepare('SELECT record_id,owner_id,drift_state,modified_on FROM record_owners WHERE zone_id=?').bind(zone).all<{ record_id: string; owner_id: string | null; drift_state: string; modified_on: string | null }>();
  return new Map(rows.results.map(r => [r.record_id, r]));
}
export async function visibleRecords(env: Env, actor: Actor, zoneId: string) {
  const { policy } = await zoneFor(env, actor, zoneId);
  const records = await listRecords(env, zoneId), owners = await ownerMap(env, zoneId);
  return records.filter(r => mayView(actor, policy, owners.get(r.id)?.owner_id ?? null)).map(r => ({ ...r, owner_id: owners.get(r.id)?.owner_id ?? null, drift_state: owners.get(r.id)?.drift_state ?? 'unclaimed' }));
}
export async function visibleRecord(env: Env, actor: Actor, zoneId: string, recordId: string) {
  const { policy } = await zoneFor(env, actor, zoneId);
  const records = await listRecords(env, zoneId);
  const record = records.find(r => r.id === recordId);
  if (!record) throw new AppError(404, '记录不存在');
  const owner = await ownerFor(env, zoneId, recordId);
  if (!mayView(actor, policy, owner?.owner_id ?? null)) throw new AppError(404, '记录不存在');
  return { ...record, owner_id: owner?.owner_id ?? null, drift_state: owner?.drift_state ?? 'unclaimed' };
}

async function validateChange(env: Env, actor: Actor, zone: Zone, policy: Policy | null, kind: ChangeKind, recordId: string | null, payload: unknown, expected?: string | null) {
  const records = await listRecords(env, zone.id);
  const current = recordId ? records.find(r => r.id === recordId) : undefined;
  if (kind !== 'create' && !current) throw new AppError(404, '记录不存在');
  const owner = current ? await ownerFor(env, zone.id, current.id) : null;
  if (actor.user.role !== 'admin') {
    if (policy?.mode === 'readonly') throw new AppError(403, '只读策略');
    if (current && (!mayWrite(actor, policy, owner?.owner_id ?? null) || owner?.drift_state !== 'ok')) throw new AppError(404, '记录不存在');
    const scopes = await scopesFor(env, actor, zone.id);
    if (!scopes.length) throw new AppError(403, '尚无获批子域名');
    if (current && !scopes.some(s => under(current.name, s))) throw new AppError(404, '记录不存在');
  }
  if (expected && current?.modified_on !== expected) throw new AppError(409, '记录已变化，请重新提交');
  if (current && owner?.modified_on && current.modified_on !== owner.modified_on && actor.user.role !== 'admin') {
    await env.DB.prepare("UPDATE record_owners SET drift_state='drift' WHERE zone_id=? AND record_id=?").bind(zone.id, current.id).run();
    throw new AppError(409, '记录状态待管理员核对');
  }
  let clean: Record<string, unknown> | null = null;
  if (kind !== 'delete') {
    const submitted = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>) } : payload;
    if (submitted && typeof submitted === 'object' && !Array.isArray(submitted)) {
      const fields = submitted as Record<string, unknown>;
      if (actor.user.role !== 'admin' && !policy?.allow_proxy && current?.proxied === true && fields.proxied === true) delete fields.proxied;
    }
    clean = validatePayload(submitted, zone, policy, actor);
    if (actor.user.role !== 'admin') {
      const scopes = await scopesFor(env, actor, zone.id);
      if (!scopes.some(s => under(clean!.name as string, s))) throw new AppError(403, '名称不在授权范围');
    }
    const name = clean.name as string;
    for (const other of records) {
      if (other.id === recordId) continue;
      const same = other.name === name;
      const structural = ((clean.type === 'NS' || clean.type === 'CNAME') && under(other.name, name)) || ((other.type === 'NS' || other.type === 'CNAME') && under(name, other.name));
      if (!same && !structural) continue;
      if (actor.user.role === 'admin') continue;
      const otherOwner = await ownerFor(env, zone.id, other.id);
      if (structural || otherOwner?.owner_id !== actor.user.id) throw new AppError(409, '名称不可用');
    }
  }
  return { records, current, owner, clean };
}

export async function submitChange(env: Env, actor: Actor, zoneId: string, kind: ChangeKind, recordId: string | null, payload: unknown) {
  const { zone, policy } = await zoneFor(env, actor, zoneId);
  const checked = await validateChange(env, actor, zone, policy, kind, recordId, payload);
  if (actor.user.role !== 'admin' && policy?.require_approval) {
    const changeId = id();
    await env.DB.prepare("INSERT INTO pending_changes (id,user_id,zone_id,kind,record_id,payload_json,expected_modified_on,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)")
      .bind(changeId, actor.user.id, zoneId, kind, recordId, checked.clean ? JSON.stringify(checked.clean) : null, checked.current?.modified_on ?? null, now()).run();
    await audit(env, actor.user.id, zoneId, 'change.request', changeId, 'pending', checked.current, checked.clean);
    return { pending: true, id: changeId };
  }
  return executeChange(env, actor, zoneId, kind, recordId, checked.clean, null);
}

export async function executeChange(env: Env, actor: Actor, zoneId: string, kind: ChangeKind, recordId: string | null, payload: unknown, expected: string | null) {
  const op = id(), lockKey = `zone:${zoneId}`;
  if (!await lock(env, lockKey, op, 180)) throw new AppError(409, '该域名正在处理另一项变更');
  let apiChanged = false, apiAttempted = false, reserved = false;
  try {
    const { zone, policy } = await zoneFor(env, actor, zoneId);
    const { current, clean } = await validateChange(env, actor, zone, policy, kind, recordId, payload, expected);
    await env.DB.prepare("INSERT INTO operations (id,user_id,zone_id,kind,record_id,payload_json,before_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'started',?,?)")
      .bind(op, actor.user.id, zoneId, kind, recordId, clean ? JSON.stringify(clean) : null, current ? JSON.stringify(current) : null, now(), now()).run();
    if (kind === 'create' && actor.user.role !== 'admin') {
      const owned = await env.DB.prepare('SELECT COUNT(*) AS n FROM record_owners WHERE zone_id=? AND owner_id=?').bind(zoneId, actor.user.id).first<{ n: number }>();
      const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM quota_reservations WHERE zone_id=? AND user_id=?').bind(zoneId, actor.user.id).first<{ n: number }>();
      if ((owned?.n ?? 0) + (pending?.n ?? 0) >= (policy?.max_records ?? 0)) throw new AppError(403, '记录数量达到上限');
      await env.DB.prepare('INSERT INTO quota_reservations (operation_id,user_id,zone_id,expires_at) VALUES (?,?,?,?)').bind(op, actor.user.id, zoneId, now() + 180).run();
      reserved = true;
    }
    if (actor.user.role !== 'admin') {
      const fresh = await env.DB.withSession('first-primary').prepare('SELECT status FROM users WHERE id=?').bind(actor.user.id).first<{ status: string }>();
      if (fresh?.status !== 'active') throw new AppError(403, '账号已停用');
    }
    let result: DnsRecord | null = null;
    if (kind === 'create') {
      const tags = [actor.user.role === 'admin' ? 'dns-panel:admin' : `dns-panel:${actor.user.id}`, `dns-panel-op:${op}`];
      apiAttempted = true;
      result = await createRecord(env, zoneId, { ...clean, tags }); apiChanged = true;
      await env.DB.prepare('UPDATE operations SET record_id=?,after_json=?,updated_at=? WHERE id=?').bind(result.id, JSON.stringify(result), now(), op).run();
      await env.DB.prepare('INSERT INTO record_owners (zone_id,record_id,owner_id,modified_on,snapshot_json) VALUES (?,?,?,?,?)')
        .bind(zoneId, result.id, actor.user.role === 'admin' ? null : actor.user.id, result.modified_on ?? null, JSON.stringify(result)).run();
    } else if (kind === 'update' && current && recordId) {
      apiAttempted = true;
      result = await updateRecord(env, zoneId, recordId, clean); apiChanged = true;
      await env.DB.prepare('UPDATE operations SET after_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(result), now(), op).run();
      await env.DB.prepare('INSERT INTO record_owners (zone_id,record_id,owner_id,modified_on,snapshot_json,drift_state) VALUES (?,?,?,?,?,\'ok\') ON CONFLICT(zone_id,record_id) DO UPDATE SET modified_on=excluded.modified_on,snapshot_json=excluded.snapshot_json,drift_state=\'ok\'')
        .bind(zoneId, recordId, (await ownerFor(env, zoneId, recordId))?.owner_id ?? null, result.modified_on ?? null, JSON.stringify(result)).run();
    } else if (kind === 'delete' && recordId) {
      apiAttempted = true;
      await deleteRecord(env, zoneId, recordId); apiChanged = true;
      await env.DB.prepare('DELETE FROM record_owners WHERE zone_id=? AND record_id=?').bind(zoneId, recordId).run();
    }
    await env.DB.prepare("UPDATE operations SET status='done',updated_at=? WHERE id=?").bind(now(), op).run();
    await audit(env, actor.user.id, zoneId, `dns.${kind}`, result?.id ?? recordId, 'success', current, result);
    return { pending: false, record: result, id: op };
  } catch (error) {
    const ambiguous = apiChanged || apiAttempted;
    await env.DB.prepare("UPDATE operations SET status=?,error=?,updated_at=? WHERE id=?")
      .bind(ambiguous ? 'needs_reconcile' : 'failed', error instanceof Error ? error.message.slice(0, 200) : 'unknown', now(), op).run().catch(() => {});
    await audit(env, actor.user.id, zoneId, `dns.${kind}`, recordId, ambiguous ? 'needs_reconcile' : 'failed', undefined, undefined, error instanceof Error ? error.message : 'unknown').catch(() => {});
    throw ambiguous ? new AppError(503, '操作结果待对账，请勿立即重试') : error;
  } finally {
    if (reserved && !apiChanged && !apiAttempted) await env.DB.prepare('DELETE FROM quota_reservations WHERE operation_id=?').bind(op).run().catch(() => {});
    if (reserved && apiChanged) await env.DB.prepare('DELETE FROM quota_reservations WHERE operation_id=? AND EXISTS (SELECT 1 FROM operations WHERE id=? AND status=\'done\')').bind(op, op).run().catch(() => {});
    await unlock(env, lockKey, op).catch(() => {});
  }
}

export async function purge(env: Env, actor: Actor, zoneId: string, rawHost: unknown) {
  const { zone, policy } = await zoneFor(env, actor, zoneId);
  if (actor.user.role !== 'admin' && !policy?.allow_purge) throw new AppError(403, '未获清缓存权限');
  const host = normalizeName(rawHost, zone.name);
  if (actor.user.role !== 'admin') {
    const scopes = await scopesFor(env, actor, zoneId);
    if (!scopes.some(s => under(host, s))) throw new AppError(403, '名称不在授权范围');
    const records = await listRecords(env, zoneId);
    const named = records.filter(r => r.name === host);
    if (!named.length) throw new AppError(403, '名称不可清理');
    for (const r of named) if ((await ownerFor(env, zoneId, r.id))?.owner_id !== actor.user.id) throw new AppError(403, '名称不可清理');
  }
  const result = await purgeHost(env, zoneId, host);
  await audit(env, actor.user.id, zoneId, 'cache.purge', host, 'success', undefined, result);
  return result;
}

export async function reconcile(env: Env, zoneId: string, actorId: string | null = null) {
  const op = id(), lockKey = `zone:${zoneId}`;
  if (!await lock(env, lockKey, op, 300)) throw new AppError(409, '该域名正在处理另一项变更');
  try {
    const records = await listRecords(env, zoneId), live = new Map(records.map(r => [r.id, r]));
    const existing = await ownerMap(env, zoneId);
    let imported = 0, drifted = 0, missing = 0;
    for (const r of records) {
      const old = existing.get(r.id);
      if (!old) {
        const tag = r.tags?.find(t => t.startsWith('dns-panel:'))?.slice('dns-panel:'.length);
        const operationTag = r.tags?.find(t => t.startsWith('dns-panel-op:'))?.slice('dns-panel-op:'.length);
        const opRow = tag && operationTag ? await env.DB.prepare("SELECT id FROM operations WHERE id=? AND user_id=? AND zone_id=? AND kind='create'").bind(operationTag, tag, zoneId).first() : null;
        const owner = opRow ? tag : null;
        await env.DB.prepare('INSERT OR IGNORE INTO record_owners (zone_id,record_id,owner_id,modified_on,snapshot_json) VALUES (?,?,?,?,?)').bind(zoneId, r.id, owner, r.modified_on ?? null, JSON.stringify(r)).run();
        if (opRow) await env.DB.prepare("UPDATE operations SET record_id=?,status='done',updated_at=? WHERE id=?").bind(r.id, now(), operationTag).run();
        imported++;
      } else if (old.modified_on !== (r.modified_on ?? null) && old.drift_state !== 'drift') {
        await env.DB.prepare("UPDATE record_owners SET drift_state='drift' WHERE zone_id=? AND record_id=?").bind(zoneId, r.id).run(); drifted++;
      }
    }
    for (const [recordId, old] of existing) if (!live.has(recordId) && old.drift_state !== 'missing') {
      await env.DB.prepare("UPDATE record_owners SET drift_state='missing' WHERE zone_id=? AND record_id=?").bind(zoneId, recordId).run(); missing++;
    }
    const pendingOps = await env.DB.prepare("SELECT id,kind,record_id,payload_json,before_json,created_at FROM operations WHERE zone_id=? AND status IN ('started','needs_reconcile')").bind(zoneId).all<{ id: string; kind: string; record_id: string | null; payload_json: string | null; before_json: string | null; created_at: number }>();
    for (const pending of pendingOps.results) {
      const tagged = records.find(r => r.tags?.includes(`dns-panel-op:${pending.id}`));
      if (pending.kind === 'create' && tagged) {
        await env.DB.prepare("UPDATE operations SET record_id=?,status='done',updated_at=? WHERE id=?").bind(tagged.id, now(), pending.id).run();
        await env.DB.prepare('DELETE FROM quota_reservations WHERE operation_id=?').bind(pending.id).run();
      } else if (now() - pending.created_at > 300 && pending.kind === 'create') {
        await env.DB.prepare("UPDATE operations SET status='failed',updated_at=? WHERE id=?").bind(now(), pending.id).run();
        await env.DB.prepare('DELETE FROM quota_reservations WHERE operation_id=?').bind(pending.id).run();
      } else if (pending.kind === 'delete' && pending.record_id && !live.has(pending.record_id)) {
        await env.DB.prepare('DELETE FROM record_owners WHERE zone_id=? AND record_id=?').bind(zoneId, pending.record_id).run();
        await env.DB.prepare("UPDATE operations SET status='done',updated_at=? WHERE id=?").bind(now(), pending.id).run();
      } else if (pending.kind === 'update' && pending.record_id) {
        const actual = live.get(pending.record_id);
        const desired = pending.payload_json ? JSON.parse(pending.payload_json) as Record<string, unknown> : null;
        const before = pending.before_json ? JSON.parse(pending.before_json) as DnsRecord : null;
        if (actual && desired && before && actual.modified_on !== before.modified_on && Object.entries(desired).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value))) {
          await env.DB.prepare("UPDATE record_owners SET modified_on=?,snapshot_json=?,drift_state='ok' WHERE zone_id=? AND record_id=?").bind(actual.modified_on ?? null, JSON.stringify(actual), zoneId, actual.id).run();
          await env.DB.prepare("UPDATE operations SET after_json=?,status='done',updated_at=? WHERE id=?").bind(JSON.stringify(actual), now(), pending.id).run();
        } else if (actual && before && actual.modified_on === before.modified_on && now() - pending.created_at > 300) {
          await env.DB.prepare("UPDATE operations SET status='failed',updated_at=? WHERE id=?").bind(now(), pending.id).run();
        }
      }
    }
    const summary = { imported, drifted, missing, total: records.length };
    await audit(env, actorId, zoneId, 'dns.reconcile', null, 'success', undefined, summary);
    return summary;
  } finally { await unlock(env, lockKey, op); }
}
