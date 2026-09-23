import { AppError, id, now, type Env } from './types';

export async function audit(env: Env, actor: string | null, zone: string | null, action: string, target: string | null, result: string, before?: unknown, after?: unknown, detail?: string) {
  await env.DB.prepare('INSERT INTO audit_events (id,actor_id,zone_id,action,target_id,before_json,after_json,result,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id(), actor, zone, action, target, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), result, detail ?? null, now()).run();
}
export async function lock(env: Env, key: string, op: string, ttl = 90): Promise<boolean> {
  const t = now();
  const result = await env.DB.prepare('INSERT INTO locks (key,operation_id,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET operation_id=excluded.operation_id,expires_at=excluded.expires_at WHERE locks.expires_at<? RETURNING operation_id')
    .bind(key, op, t + ttl, t).first<{ operation_id: string }>();
  return result?.operation_id === op;
}
export async function unlock(env: Env, key: string, op: string) {
  await env.DB.prepare('DELETE FROM locks WHERE key=? AND operation_id=?').bind(key, op).run();
}
export async function withZoneLock<T>(env: Env, zone: string, work: () => Promise<T>): Promise<T> {
  const op = id(), key = `zone:${zone}`;
  if (!await lock(env, key, op, 180)) throw new AppError(409, '该域名正在处理另一项变更');
  try { return await work(); } finally { await unlock(env, key, op); }
}
