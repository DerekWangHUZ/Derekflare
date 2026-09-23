import { acceptInvite, actorFor, bootstrap, cookieHeader, csrfFor, finishTotp, issueSession, login, requireCsrf, startTotp } from './auth';
import { verifyZone, getRecord, listRecords } from './cloudflare';
import { audit, lock, unlock, withZoneLock } from './db';
import { executeChange, purge, reconcile, submitChange, visibleRecord, visibleRecords } from './operations';
import { normalizeName, ownerFor, scopesFor, under, validateScopeAssignment, zoneFor } from './policy';
import { decryptTotp, hashPassword, randomToken, sha256, verifyPassword, verifyTotp } from './crypto';
import { ensureSchema } from './schema';
import { AppError, id, now, type Actor, type Env, type Mode, type Policy, type User, type Zone } from './types';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains', 'X-Content-Type-Options': 'nosniff', ...headers } });
const ADMIN_ONLY = (actor: Actor) => { if (actor.user.role !== 'admin') throw new AppError(403, '无权限'); };
const modes = new Set<Mode>(['self','collaborate','delegate','readonly']);

async function body(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > 32768) throw new AppError(413, '请求过大');
  const reader = request.body?.getReader(); if (!reader) return {};
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 32768) { await reader.cancel(); throw new AppError(413, '请求过大'); } chunks.push(value); }
  const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  try { const result = JSON.parse(new TextDecoder().decode(raw)); if (result && typeof result === 'object' && !Array.isArray(result)) return result; } catch {}
  throw new AppError(400, 'JSON 无效');
}
const text = (value: unknown) => typeof value === 'string' ? value : '';
const boolean = (value: unknown) => value === true ? 1 : 0;
const zoneIdOf = (url: URL, input?: Record<string, unknown>) => text(input?.zoneId ?? url.searchParams.get('zone'));

async function adminScope(env: Env, actor: Actor, userId: string, zoneId: string, rawName: unknown, requestId?: string) {
  ADMIN_ONLY(actor);
  const user = await env.DB.prepare('SELECT id,status FROM users WHERE id=? AND role=\'friend\'').bind(userId).first<{ id: string; status: string }>();
  if (!user || user.status === 'disabled') throw new AppError(404, '账号不存在');
  const { zone } = await zoneFor(env, actor, zoneId);
  const name = normalizeName(rawName, zone.name);
  const op = id(), lk = `zone:${zoneId}`;
  if (!await lock(env, lk, op)) throw new AppError(409, '该域名正在处理另一项变更');
  try {
    const policy = await env.DB.prepare('SELECT * FROM policies WHERE user_id=? AND zone_id=?').bind(userId, zoneId).first<Policy>();
    if (!policy) throw new AppError(400, '请先配置该账号的域名策略');
    const fullZone = name === zone.name && !requestId && policy.mode === 'delegate';
    await validateScopeAssignment(env, zone, name, await listRecords(env, zoneId), userId, fullZone);
    const statements = [env.DB.prepare('INSERT INTO scopes (id,user_id,zone_id,name,created_at) VALUES (?,?,?,?,?)').bind(id(), userId, zoneId, name, now())];
    if (requestId) statements.push(env.DB.prepare("UPDATE scope_requests SET status='approved',reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'").bind(actor.user.id, now(), requestId));
    await env.DB.batch(statements);
    await audit(env, actor.user.id, zoneId, 'scope.approve', name, 'success', undefined, { userId, name });
    return { name, userId };
  } finally { await unlock(env, lk, op); }
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  await ensureSchema(env);
  const method = request.method, path = url.pathname, parts = path.split('/').filter(Boolean);
  if (method === 'POST' && path === '/api/bootstrap') {
    const cookie = await bootstrap(env, await body(request)); return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }
  if (method === 'POST' && path === '/api/login') {
    const cookie = await login(request, env, await body(request)); return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }
  if (method === 'POST' && path === '/api/invites/accept') {
    const cookie = await acceptInvite(env, await body(request)); return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }
  if (method === 'GET' && path === '/api/bootstrap/status') {
    const admin = await env.DB.prepare("SELECT id FROM users WHERE role='admin'").first();
    return json({ needed: !admin });
  }
  const actor = await actorFor(request, env);
  if (!['GET','HEAD'].includes(method)) await requireCsrf(request, env, actor);
  if (method === 'GET' && path === '/api/me') return json({ id: actor.user.id, username: actor.user.username, role: actor.user.role, totpEnabled: !!actor.user.totp_enabled, csrf: await csrfFor(request, env) });
  if (method === 'POST' && path === '/api/logout') {
    await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').bind(now(), actor.sessionId).run();
    await audit(env, actor.user.id, null, 'auth.logout', null, 'success');
    return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
  }
  if (method === 'POST' && path === '/api/totp/start') { const input = await body(request); return json(await startTotp(env, actor, text(input.password), text(input.code))); }
  if (method === 'POST' && path === '/api/totp/finish') { await finishTotp(env, actor, text((await body(request)).code)); return json({ ok: true }); }
  if (method === 'POST' && path === '/api/password') {
    const input = await body(request), user = actor.user;
    if (!user.password_hash || !user.password_salt || !user.password_iterations || !await verifyPassword(text(input.currentPassword), user.password_salt, user.password_hash, user.password_iterations)) throw new AppError(403, '当前密码无效');
    if (user.totp_enabled && (!user.totp_secret || !await verifyTotp(await decryptTotp(user.totp_secret, env.TOTP_KEY), text(input.totp)))) throw new AppError(403, 'TOTP 验证失败');
    const next = await hashPassword(text(input.newPassword));
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,password_iterations=? WHERE id=?').bind(next.hash, next.salt, next.iterations, user.id),
      env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=?').bind(now(), user.id),
    ]);
    await audit(env, user.id, null, 'auth.password.change', user.id, 'success');
    return json({ ok: true }, 200, { 'Set-Cookie': await issueSession(env, user.id) });
  }

  if (method === 'GET' && path === '/api/zones') {
    const rows = actor.user.role === 'admin'
      ? await env.DB.prepare('SELECT * FROM zones WHERE enabled=1 ORDER BY name').all<Zone>()
      : await env.DB.prepare('SELECT z.* FROM zones z JOIN policies p ON p.zone_id=z.id WHERE p.user_id=? AND z.enabled=1 ORDER BY z.name').bind(actor.user.id).all<Zone>();
    return json(rows.results);
  }
  if (method === 'GET' && path === '/api/policies') {
    const zone = zoneIdOf(url); await zoneFor(env, actor, zone);
    const row = actor.user.role === 'admin' ? null : await env.DB.prepare('SELECT * FROM policies WHERE user_id=? AND zone_id=?').bind(actor.user.id, zone).first<Policy>();
    return json(row);
  }
  if (method === 'GET' && path === '/api/scopes') {
    const zone = zoneIdOf(url); await zoneFor(env, actor, zone);
    const rows = actor.user.role === 'admin'
      ? await env.DB.prepare('SELECT * FROM scopes WHERE zone_id=? ORDER BY name').bind(zone).all()
      : await env.DB.prepare('SELECT * FROM scopes WHERE zone_id=? AND user_id=? ORDER BY name').bind(zone, actor.user.id).all();
    return json(rows.results);
  }
  if (method === 'GET' && path === '/api/scopes/requests') {
    const rows = actor.user.role === 'admin'
      ? await env.DB.prepare('SELECT * FROM scope_requests ORDER BY created_at DESC LIMIT 200').all()
      : await env.DB.prepare('SELECT * FROM scope_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(actor.user.id).all();
    return json(rows.results);
  }
  if (method === 'POST' && path === '/api/scopes/requests') {
    if (actor.user.role === 'admin') throw new AppError(400, '管理员可直接分配范围');
    const input = await body(request), zoneId = text(input.zoneId);
    const { zone } = await zoneFor(env, actor, zoneId), name = normalizeName(input.name, zone.name);
    if (name === zone.name) throw new AppError(400, '须申请子域名');
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM scope_requests WHERE user_id=? AND status='pending'").bind(actor.user.id).first<{ n: number }>();
    if ((pending?.n ?? 0) >= 5) throw new AppError(429, '待处理申请过多');
    const requestId = id();
    await env.DB.prepare("INSERT INTO scope_requests (id,user_id,zone_id,name,status,created_at) VALUES (?,?,?,?,'pending',?)").bind(requestId, actor.user.id, zoneId, name, now()).run();
    await audit(env, actor.user.id, zoneId, 'scope.request', requestId, 'pending', undefined, { name });
    return json({ id: requestId, status: 'pending' }, 202);
  }

  if (method === 'GET' && path === '/api/records') return json(await visibleRecords(env, actor, zoneIdOf(url)));
  if (method === 'GET' && parts[1] === 'records' && parts.length === 3) return json(await visibleRecord(env, actor, zoneIdOf(url), parts[2]));
  if (method === 'POST' && path === '/api/records') {
    const input = await body(request); return json(await submitChange(env, actor, text(input.zoneId), 'create', null, input.record), 201);
  }
  if ((method === 'PATCH' || method === 'DELETE') && parts[1] === 'records' && parts.length === 3) {
    const input = await body(request); return json(await submitChange(env, actor, text(input.zoneId), method === 'PATCH' ? 'update' : 'delete', parts[2], input.record));
  }
  if (method === 'POST' && path === '/api/cache/purge') {
    const input = await body(request); return json(await purge(env, actor, text(input.zoneId), input.host));
  }

  if (!path.startsWith('/api/admin/')) throw new AppError(404, '接口不存在');
  ADMIN_ONLY(actor);
  if (method === 'GET' && path === '/api/admin/users') return json((await env.DB.prepare("SELECT id,username,role,status,totp_enabled,created_at FROM users WHERE role='friend' AND (status='pending' OR password_hash IS NOT NULL) ORDER BY created_at DESC").all()).results);
  if (method === 'GET' && path === '/api/admin/policies') return json((await env.DB.prepare('SELECT * FROM policies ORDER BY zone_id,user_id').all()).results);
  if (method === 'POST' && path === '/api/admin/zones') {
    const input = await body(request), zone = await verifyZone(env, text(input.zoneId));
    await env.DB.prepare('INSERT OR IGNORE INTO zones (id,name,created_at) VALUES (?,?,?)').bind(zone.id, zone.name, now()).run();
    const scan = await reconcile(env, zone.id, actor.user.id);
    await audit(env, actor.user.id, zone.id, 'zone.add', zone.id, 'success', undefined, zone);
    return json({ ...zone, scan }, 201);
  }
  if (method === 'POST' && path === '/api/admin/invitations') {
    const input = await body(request), zoneId = text(input.zoneId);
    await zoneFor(env, actor, zoneId);
    const userId = id(), token = randomToken(), invitationId = id();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id,role,status,created_at) VALUES (?,'friend','pending',?)").bind(userId, now()),
      env.DB.prepare("INSERT INTO policies (user_id,zone_id,mode) VALUES (?,?,'self')").bind(userId, zoneId),
      env.DB.prepare('INSERT INTO invitations (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').bind(invitationId, userId, await sha256(token), now() + 86400, now()),
    ]);
    await audit(env, actor.user.id, zoneId, 'auth.invite.create', userId, 'success');
    return json({ userId, link: `${url.origin}/#invite=${token}`, expiresIn: 86400 }, 201);
  }
  if (method === 'PUT' && parts[2] === 'policies' && parts.length === 5) {
    const userId = parts[3], zoneId = parts[4], input = await body(request);
    await zoneFor(env, actor, zoneId);
    const user = await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='friend' AND status!='disabled'").bind(userId).first();
    if (!user) throw new AppError(404, '账号不存在');
    const mode = text(input.mode) as Mode;
    if (!modes.has(mode) || !Number.isInteger(input.maxRecords) || (input.maxRecords as number) < 0 || (input.maxRecords as number) > 100000) throw new AppError(400, '策略无效');
    const next = { mode, max_records: input.maxRecords, allow_proxy: boolean(input.allowProxy), allow_purge: boolean(input.allowPurge), require_approval: boolean(input.requireApproval) };
    const updates = [env.DB.prepare('INSERT INTO policies (user_id,zone_id,mode,max_records,allow_proxy,allow_purge,require_approval) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,zone_id) DO UPDATE SET mode=excluded.mode,max_records=excluded.max_records,allow_proxy=excluded.allow_proxy,allow_purge=excluded.allow_purge,require_approval=excluded.require_approval')
      .bind(userId, zoneId, mode, next.max_records, next.allow_proxy, next.allow_purge, next.require_approval)];
    if (mode !== 'delegate') updates.push(env.DB.prepare('DELETE FROM scopes WHERE user_id=? AND zone_id=? AND name=(SELECT name FROM zones WHERE id=?)').bind(userId, zoneId, zoneId));
    return withZoneLock(env, zoneId, async () => {
      const old = await env.DB.prepare('SELECT * FROM policies WHERE user_id=? AND zone_id=?').bind(userId, zoneId).first();
      await env.DB.batch(updates);
      await audit(env, actor.user.id, zoneId, 'policy.update', userId, 'success', old, next);
      return json(next);
    });
  }
  if (method === 'DELETE' && parts[2] === 'policies' && parts.length === 5) {
    const userId = parts[3], zoneId = parts[4]; await zoneFor(env, actor, zoneId);
    return withZoneLock(env, zoneId, async () => {
      const old = await env.DB.prepare('SELECT * FROM policies WHERE user_id=? AND zone_id=?').bind(userId, zoneId).first();
      if (!old) throw new AppError(404, '策略不存在');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM scopes WHERE user_id=? AND zone_id=?').bind(userId, zoneId),
        env.DB.prepare("UPDATE scope_requests SET status='rejected',reviewed_by=?,reviewed_at=? WHERE user_id=? AND zone_id=? AND status='pending'").bind(actor.user.id, now(), userId, zoneId),
        env.DB.prepare("UPDATE pending_changes SET status='rejected',reviewed_by=?,reviewed_at=? WHERE user_id=? AND zone_id=? AND status='pending'").bind(actor.user.id, now(), userId, zoneId),
        env.DB.prepare('DELETE FROM policies WHERE user_id=? AND zone_id=?').bind(userId, zoneId),
      ]);
      await audit(env, actor.user.id, zoneId, 'policy.remove', userId, 'success', old); return json({ ok:true });
    });
  }
  if (method === 'POST' && path === '/api/admin/scopes') {
    const input = await body(request); return json(await adminScope(env, actor, text(input.userId), text(input.zoneId), input.name), 201);
  }
  if (method === 'POST' && parts[2] === 'scopes' && parts[3] === 'requests' && parts.length === 6) {
    const requestId = parts[4], action = parts[5];
    const row = await env.DB.prepare("SELECT * FROM scope_requests WHERE id=? AND status='pending'").bind(requestId).first<{ id: string; user_id: string; zone_id: string; name: string }>();
    if (!row) throw new AppError(404, '申请不存在');
    if (action === 'approve') return json(await adminScope(env, actor, row.user_id, row.zone_id, row.name, row.id));
    if (action === 'reject') {
      return withZoneLock(env, row.zone_id, async () => {
        const changed = await env.DB.prepare("UPDATE scope_requests SET status='rejected',reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending' RETURNING id").bind(actor.user.id, now(), row.id).first();
        if (!changed) throw new AppError(409, '申请已处理');
        await audit(env, actor.user.id, row.zone_id, 'scope.reject', row.id, 'success'); return json({ ok: true });
      });
    }
  }
  if (method === 'GET' && path === '/api/admin/changes') return json((await env.DB.prepare("SELECT * FROM pending_changes WHERE status='pending' ORDER BY created_at ASC LIMIT 200").all()).results);
  if (method === 'POST' && parts[2] === 'changes' && parts.length === 5) {
    const changeId = parts[3], action = parts[4];
    const change = await env.DB.prepare("SELECT * FROM pending_changes WHERE id=? AND status='pending'").bind(changeId).first<{ id: string; user_id: string; zone_id: string; kind: 'create'|'update'|'delete'; record_id: string | null; payload_json: string | null; expected_modified_on: string | null }>();
    if (!change) throw new AppError(404, '审批单不存在');
    if (action === 'reject') {
      await env.DB.prepare("UPDATE pending_changes SET status='rejected',reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'").bind(actor.user.id, now(), changeId).run();
      await audit(env, actor.user.id, change.zone_id, 'change.reject', changeId, 'success'); return json({ ok: true });
    }
    if (action === 'approve') {
      const claimed = await env.DB.prepare("UPDATE pending_changes SET status='approved',reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending' RETURNING id").bind(actor.user.id, now(), changeId).first();
      if (!claimed) throw new AppError(409, '审批单已处理');
      try {
        const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(change.user_id).first<User>();
        if (!user || user.status !== 'active') throw new AppError(403, '原操作人已停用');
        const result = await executeChange(env, { user, sessionId: '', csrfHash: '' }, change.zone_id, change.kind, change.record_id, change.payload_json ? JSON.parse(change.payload_json) : null, change.expected_modified_on);
        await audit(env, actor.user.id, change.zone_id, 'change.approve', changeId, 'success'); return json(result);
      } catch (e) {
        const busy = e instanceof AppError && e.status === 409 && e.message === '该域名正在处理另一项变更';
        await env.DB.prepare(busy ? "UPDATE pending_changes SET status='pending',reviewed_by=NULL,reviewed_at=NULL WHERE id=?" : "UPDATE pending_changes SET status='failed' WHERE id=?").bind(changeId).run();
        await audit(env, actor.user.id, change.zone_id, 'change.approve', changeId, busy ? 'deferred' : 'failed', undefined, undefined, e instanceof Error ? e.message : 'unknown'); throw e;
      }
    }
  }
  if (method === 'GET' && path === '/api/admin/audit') {
    const page = Number(url.searchParams.get('page') ?? '0');
    if (!Number.isInteger(page) || page < 0 || page > 100000) throw new AppError(400, '页码无效');
    return json((await env.DB.prepare('SELECT * FROM audit_events ORDER BY created_at DESC,id DESC LIMIT 200 OFFSET ?').bind(page * 200).all()).results);
  }
  if (method === 'GET' && path === '/api/admin/drift') {
    const zoneId = zoneIdOf(url); await zoneFor(env, actor, zoneId);
    return json((await env.DB.prepare("SELECT record_id,owner_id,drift_state,modified_on FROM record_owners WHERE zone_id=? AND drift_state!='ok' ORDER BY record_id LIMIT 500").bind(zoneId).all()).results);
  }
  if (method === 'GET' && path === '/api/admin/operations') {
    const zoneId = zoneIdOf(url); await zoneFor(env, actor, zoneId);
    return json((await env.DB.prepare("SELECT id,user_id,kind,record_id,status,error,created_at FROM operations WHERE zone_id=? AND status='needs_reconcile' ORDER BY created_at DESC LIMIT 200").bind(zoneId).all()).results);
  }
  if (method === 'POST' && parts[2] === 'operations' && parts.length === 5 && parts[4] === 'resolve') {
    const operationId = parts[3], input = await body(request), zoneId = text(input.zoneId);
    await zoneFor(env, actor, zoneId);
    return withZoneLock(env, zoneId, async () => {
      const operation = await env.DB.prepare("SELECT * FROM operations WHERE id=? AND zone_id=? AND status='needs_reconcile'").bind(operationId, zoneId).first();
      if (!operation) throw new AppError(404, '待对账操作不存在');
      await env.DB.batch([
        env.DB.prepare("UPDATE operations SET status='failed',updated_at=? WHERE id=?").bind(now(), operationId),
        env.DB.prepare('DELETE FROM quota_reservations WHERE operation_id=?').bind(operationId),
      ]);
      await audit(env, actor.user.id, zoneId, 'operation.resolve', operationId, 'reviewed', operation);
      return json({ ok: true });
    });
  }
  if (method === 'POST' && parts[2] === 'users' && parts.length === 5) {
    const userId = parts[3], action = parts[4];
    const user = await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='friend'").bind(userId).first();
    if (!user) throw new AppError(404, '账号不存在');
    if (action === 'disable' || action === 'delete') {
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(userId),
        env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now(), userId),
        env.DB.prepare('UPDATE invitations SET used_at=? WHERE user_id=? AND used_at IS NULL').bind(now(), userId),
        env.DB.prepare("UPDATE pending_changes SET status='rejected',reviewed_by=?,reviewed_at=? WHERE user_id=? AND status='pending'").bind(actor.user.id, now(), userId),
        env.DB.prepare("UPDATE scope_requests SET status='rejected',reviewed_by=?,reviewed_at=? WHERE user_id=? AND status='pending'").bind(actor.user.id, now(), userId),
      ]);
      if (action === 'delete') await env.DB.batch([
        env.DB.prepare('UPDATE record_owners SET owner_id=NULL WHERE owner_id=?').bind(userId),
        env.DB.prepare('DELETE FROM scopes WHERE user_id=?').bind(userId),
        env.DB.prepare('DELETE FROM policies WHERE user_id=?').bind(userId),
        env.DB.prepare('UPDATE users SET username=NULL,password_hash=NULL,password_salt=NULL,totp_secret=NULL,totp_pending_secret=NULL,totp_enabled=0 WHERE id=?').bind(userId),
      ]);
      await audit(env, actor.user.id, null, `user.${action}`, userId, 'success'); return json({ ok: true });
    }
    if (action === 'enable') {
      const restored = await env.DB.prepare("UPDATE users SET status='active',failed_count=0,locked_until=0 WHERE id=? AND password_hash IS NOT NULL RETURNING id").bind(userId).first();
      if (!restored) throw new AppError(409, '已删除的账号不能恢复');
      await audit(env, actor.user.id, null, 'user.enable', userId, 'success'); return json({ ok: true });
    }
    if (action === 'reset-totp') {
      await env.DB.prepare('UPDATE users SET totp_secret=NULL,totp_pending_secret=NULL,totp_enabled=0 WHERE id=?').bind(userId).run();
      await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now(), userId).run();
      await audit(env, actor.user.id, null, 'user.totp.reset', userId, 'success'); return json({ ok: true });
    }
    if (action === 'reset-password') {
      const assigned = await env.DB.prepare('SELECT 1 AS present FROM policies WHERE user_id=? LIMIT 1').bind(userId).first();
      if (!assigned) throw new AppError(409, '已删除的账号不能找回');
      const token = randomToken();
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET status='pending',password_hash=NULL,password_salt=NULL,password_iterations=NULL WHERE id=?").bind(userId),
        env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now(), userId),
        env.DB.prepare('UPDATE invitations SET used_at=? WHERE user_id=? AND used_at IS NULL').bind(now(), userId),
        env.DB.prepare("UPDATE pending_changes SET status='rejected',reviewed_by=?,reviewed_at=? WHERE user_id=? AND status='pending'").bind(actor.user.id, now(), userId),
        env.DB.prepare('INSERT INTO invitations (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').bind(id(), userId, await sha256(token), now() + 86400, now()),
      ]);
      await audit(env, actor.user.id, null, 'user.password.reset', userId, 'success');
      return json({ link: `${url.origin}/#invite=${token}`, expiresIn: 86400 });
    }
  }
  if (method === 'POST' && parts[2] === 'records' && parts.length === 5 && parts[4] === 'owner') {
    const recordId = parts[3], input = await body(request), zoneId = text(input.zoneId);
    await zoneFor(env, actor, zoneId);
    return withZoneLock(env, zoneId, async () => {
      const record = await getRecord(env, zoneId, recordId);
      const nextOwner = input.userId === null ? null : text(input.userId);
      if (nextOwner) {
        const target = await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='friend' AND status='active'").bind(nextOwner).first();
        if (!target) throw new AppError(400, '目标账号不可用');
      }
      const previous = await ownerFor(env, zoneId, recordId);
      await env.DB.prepare("INSERT INTO record_owners (zone_id,record_id,owner_id,modified_on,snapshot_json,drift_state) VALUES (?,?,?,?,?,'ok') ON CONFLICT(zone_id,record_id) DO UPDATE SET owner_id=excluded.owner_id,modified_on=excluded.modified_on,snapshot_json=excluded.snapshot_json,drift_state='ok'")
        .bind(zoneId, recordId, nextOwner, record.modified_on ?? null, JSON.stringify(record)).run();
      await audit(env, actor.user.id, zoneId, 'record.owner', recordId, 'success', previous, { ownerId: nextOwner }); return json({ ownerId: nextOwner });
    });
  }
  if (method === 'POST' && parts[2] === 'records' && parts.length === 5 && parts[4] === 'ack') {
    const recordId = parts[3], input = await body(request), zoneId = text(input.zoneId);
    await zoneFor(env, actor, zoneId);
    return withZoneLock(env, zoneId, async () => {
      const record = await getRecord(env, zoneId, recordId);
      await env.DB.prepare("UPDATE record_owners SET modified_on=?,snapshot_json=?,drift_state='ok' WHERE zone_id=? AND record_id=?")
        .bind(record.modified_on ?? null, JSON.stringify(record), zoneId, recordId).run();
      await audit(env, actor.user.id, zoneId, 'record.drift.ack', recordId, 'success'); return json({ ok: true });
    });
  }
  if (method === 'POST' && parts[2] === 'records' && parts.length === 5 && parts[4] === 'resolve-missing') {
    const recordId = parts[3], input = await body(request), zoneId = text(input.zoneId);
    await zoneFor(env, actor, zoneId);
    return withZoneLock(env, zoneId, async () => {
      const live = await listRecords(env, zoneId);
      if (live.some(r => r.id === recordId)) throw new AppError(409, '记录仍存在');
      await env.DB.prepare("DELETE FROM record_owners WHERE zone_id=? AND record_id=? AND drift_state='missing'").bind(zoneId, recordId).run();
      await audit(env, actor.user.id, zoneId, 'record.missing.resolve', recordId, 'success'); return json({ ok: true });
    });
  }
  if (method === 'POST' && path === '/api/admin/reconcile') {
    const input = await body(request); const zoneId = text(input.zoneId); await zoneFor(env, actor, zoneId); return json(await reconcile(env, zoneId, actor.user.id));
  }
  throw new AppError(404, '接口不存在');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.protocol !== 'https:' && !['127.0.0.1','localhost'].includes(url.hostname)) throw new AppError(403, '必须使用 HTTPS');
      if (!['GET','HEAD'].includes(request.method) && request.headers.get('Origin') !== url.origin) throw new AppError(403, '请求来源无效');
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new AppError(405, '方法无效');
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
      response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      return response;
    } catch (error) {
      if (error instanceof AppError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: 'unhandled', message: error instanceof Error ? error.message : 'unknown' }));
      return json({ error: '服务器错误' }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env);
    const zones = await env.DB.prepare('SELECT id FROM zones WHERE enabled=1').all<{ id: string }>();
    for (const zone of zones.results) {
      try { await reconcile(env, zone.id); } catch (error) { console.error(JSON.stringify({ event: 'reconcile_failed', zone: zone.id, message: error instanceof Error ? error.message : 'unknown' })); }
    }
  },
};
