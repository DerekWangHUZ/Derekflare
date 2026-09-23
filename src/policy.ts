import { AppError, type Actor, type DnsRecord, type Env, type Policy, type Zone } from './types';

export const TYPES = new Set('A AAAA CNAME MX NS OPENPGPKEY PTR TXT CAA CERT DNSKEY DS HTTPS LOC NAPTR SMIMEA SRV SSHFP SVCB TLSA URI'.split(' '));
export const DEFAULT_ALLOWED_TYPES = ['A', 'AAAA', 'CNAME', 'TXT'];
export function validateAllowedTypes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > TYPES.size || input.some(type => typeof type !== 'string' || !TYPES.has(type)) || new Set(input).size !== input.length) {
    throw new AppError(400, '允许的记录类型无效');
  }
  return [...TYPES].filter(type => input.includes(type));
}
export function allowedTypesFor(policy: Policy): string[] {
  try { return validateAllowedTypes(JSON.parse(policy.allowed_types_json)); } catch { return []; }
}
export function policyForApi(policy: Policy): Omit<Policy, 'allowed_types_json'> & { allowedTypes: string[] } {
  const { allowed_types_json: _, ...rest } = policy;
  return { ...rest, allowedTypes: allowedTypesFor(policy) };
}
export async function zoneFor(env: Env, actor: Actor, zoneId: string): Promise<{ zone: Zone; policy: Policy | null }> {
  const zone = await env.DB.prepare('SELECT * FROM zones WHERE id=? AND enabled=1').bind(zoneId).first<Zone>();
  if (!zone) throw new AppError(404, '域名不存在');
  if (actor.user.role === 'admin') return { zone, policy: null };
  const policy = await env.DB.prepare('SELECT * FROM policies WHERE user_id=? AND zone_id=?').bind(actor.user.id, zoneId).first<Policy>();
  if (!policy) throw new AppError(404, '域名不存在');
  return { zone, policy };
}
export function normalizeName(input: unknown, zone: string): string {
  if (typeof input !== 'string' || input.length > 255 || input.trim() !== input) throw new AppError(400, '记录名称无效');
  const raw = input.toLowerCase().replace(/\.$/, '');
  if (raw === '@') return zone;
  if (/[\\/\@:%?#]/.test(raw)) throw new AppError(400, '记录名称无效');
  let normalized: string;
  try { normalized = new URL(`https://${raw}/`).hostname.replace(/\.$/, ''); } catch { throw new AppError(400, '记录名称无效'); }
  if (!normalized || (!normalized.endsWith(`.${zone}`) && normalized !== zone) || !/^[a-z0-9_*.-]+$/.test(normalized)) throw new AppError(400, '记录名称无效');
  if (normalized.split('.').some(x => !x || x.length > 63)) throw new AppError(400, '记录名称无效');
  return normalized;
}
export const under = (name: string, scope: string) => name === scope || name.endsWith(`.${scope}`);
export async function scopesFor(env: Env, actor: Actor, zone: string): Promise<string[]> {
  if (actor.user.role === 'admin') return [];
  const rows = await env.DB.prepare('SELECT name FROM scopes WHERE user_id=? AND zone_id=?').bind(actor.user.id, zone).all<{ name: string }>();
  return rows.results.map(x => x.name);
}
export async function ownerFor(env: Env, zone: string, record: string): Promise<{ owner_id: string | null; drift_state: string; modified_on: string | null } | null> {
  return env.DB.prepare('SELECT owner_id,drift_state,modified_on FROM record_owners WHERE zone_id=? AND record_id=?').bind(zone, record).first();
}
export const mayView = (actor: Actor, policy: Policy | null, owner: string | null) => actor.user.role === 'admin' || (!!policy && (policy.mode !== 'self' || owner === actor.user.id));
export const mayWrite = (actor: Actor, policy: Policy | null, owner: string | null) => actor.user.role === 'admin' || (!!policy && policy.mode !== 'readonly' && (policy.mode === 'delegate' || owner === actor.user.id));
export function validatePayload(input: unknown, zone: Zone, policy: Policy | null, actor: Actor): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, '记录内容无效');
  const p = input as Record<string, unknown>;
  const type = String(p.type ?? '').toUpperCase();
  if (!TYPES.has(type)) throw new AppError(400, '记录类型无效');
  const name = normalizeName(p.name, zone.name);
  if (typeof p.content !== 'string' && (typeof p.data !== 'object' || p.data === null || Array.isArray(p.data))) throw new AppError(400, '记录内容无效');
  if (p.content !== undefined && (typeof p.content !== 'string' || p.content.length > 8192)) throw new AppError(400, '记录内容无效');
  if (p.data !== undefined && (typeof p.data !== 'object' || p.data === null || Array.isArray(p.data) || JSON.stringify(p.data).length > 8192)) throw new AppError(400, '记录内容无效');
  if (p.ttl !== undefined && (!Number.isInteger(p.ttl) || (p.ttl !== 1 && ((p.ttl as number) < 30 || (p.ttl as number) > 86400)))) throw new AppError(400, 'TTL 无效');
  if (p.priority !== undefined && (!Number.isInteger(p.priority) || (p.priority as number) < 0 || (p.priority as number) > 65535)) throw new AppError(400, '优先级无效');
  if (p.proxied !== undefined && typeof p.proxied !== 'boolean') throw new AppError(400, '代理设置无效');
  if (p.proxied === true && (actor.user.role !== 'admin' && !policy?.allow_proxy || !['A','AAAA','CNAME'].includes(type))) throw new AppError(403, '不允许开启代理');
  if (p.comment !== undefined && (typeof p.comment !== 'string' || p.comment.length > 500)) throw new AppError(400, '备注无效');
  const output: Record<string, unknown> = { type, name, ttl: p.ttl ?? 1 };
  for (const key of ['content','data','priority','proxied','comment']) if (p[key] !== undefined) output[key] = p[key];
  return output;
}
export async function validateScopeAssignment(env: Env, zone: Zone, name: string, records: DnsRecord[], userId: string, fullZone = false) {
  if (name === zone.name && !fullZone) throw new AppError(400, '须申请子域名');
  if (fullZone && name === zone.name) return;
  const existing = await env.DB.prepare('SELECT name FROM scopes WHERE zone_id=?').bind(zone.id).all<{ name: string }>();
  if (existing.results.some(x => x.name !== zone.name && (under(name, x.name) || under(x.name, name)))) throw new AppError(409, '该范围不可分配');
  for (const r of records) {
    if (!under(r.name, name) && !((r.type === 'NS' || r.type === 'CNAME') && under(name, r.name))) continue;
    const owner = await ownerFor(env, zone.id, r.id);
    if (owner?.owner_id !== userId) throw new AppError(409, '该范围不可分配');
  }
}
