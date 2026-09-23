import { audit } from './db';
import { base32, bytes, decryptTotp, encryptTotp, equal, hashPassword, hmac, randomToken, sha256, verifyPassword, verifyTotp } from './crypto';
import { AppError, id, now, type Actor, type Env, type User } from './types';

const COOKIE = '__Host-dns_panel';
const SESSION_AGE = 12 * 60 * 60;
export function cookieHeader(value: string, age = SESSION_AGE) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;
}
export function readCookie(request: Request) {
  const match = request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-dns_panel=([^;]+)/);
  return match?.[1] ?? null;
}
export async function actorFor(request: Request, env: Env): Promise<Actor> {
  const cookie = readCookie(request);
  if (!cookie) throw new AppError(401, '请先登录');
  const [sessionId, token, signature] = cookie.split('.');
  if (!sessionId || !token || !signature || !equal(signature, await hmac(env.SESSION_KEY, `${sessionId}.${token}`))) throw new AppError(401, '请先登录');
  const db = env.DB.withSession('first-primary');
  const row = await db.prepare('SELECT s.id AS session_id,s.token_hash,s.csrf_hash,s.expires_at,s.revoked_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?')
    .bind(sessionId).first<User & { session_id: string; token_hash: string; csrf_hash: string; expires_at: number; revoked_at: number | null }>();
  if (!row || row.revoked_at || row.expires_at <= now() || row.status !== 'active' || !equal(row.token_hash, await sha256(token))) throw new AppError(401, '请先登录');
  return { user: row, sessionId, csrfHash: row.csrf_hash };
}
export async function csrfFor(request: Request, env: Env) {
  const cookie = readCookie(request); if (!cookie) throw new AppError(401, '请先登录');
  return hmac(env.SESSION_KEY, `csrf:${cookie.split('.')[1]}`);
}
export async function requireCsrf(request: Request, env: Env, actor: Actor) {
  const origin = request.headers.get('Origin');
  if (origin !== new URL(request.url).origin) throw new AppError(403, '请求来源无效');
  const supplied = request.headers.get('X-CSRF-Token') ?? '';
  if (!equal(await sha256(supplied), actor.csrfHash)) throw new AppError(403, '请求校验失败');
}
export async function issueSession(env: Env, userId: string) {
  const sessionId = id(), token = randomToken();
  const signature = await hmac(env.SESSION_KEY, `${sessionId}.${token}`);
  const csrf = await hmac(env.SESSION_KEY, `csrf:${token}`);
  await env.DB.prepare('INSERT INTO sessions (id,user_id,token_hash,csrf_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)')
    .bind(sessionId, userId, await sha256(token), await sha256(csrf), now() + SESSION_AGE, now()).run();
  return cookieHeader(`${sessionId}.${token}.${signature}`);
}
export async function bootstrap(env: Env, input: Record<string, unknown>) {
  const exists = await env.DB.prepare("SELECT id FROM users WHERE role='admin'").first();
  if (exists) throw new AppError(404, '不可用');
  if (typeof input.key !== 'string' || !equal(await sha256(input.key), await sha256(env.BOOTSTRAP_KEY))) throw new AppError(403, '引导密钥无效');
  const username = validateUsername(input.username);
  const p = await hashPassword(String(input.password ?? ''));
  const userId = id();
  await env.DB.prepare("INSERT INTO users (id,username,password_hash,password_salt,password_iterations,role,status,created_at) VALUES (?,?,?,?,?,'admin','active',?)")
    .bind(userId, username, p.hash, p.salt, p.iterations, now()).run();
  await audit(env, userId, null, 'admin.bootstrap', userId, 'success');
  return issueSession(env, userId);
}
export function validateUsername(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_.-]{3,40}$/.test(input)) throw new AppError(400, '用户名需为 3–40 位字母、数字或 _ . -');
  return input;
}
async function limit(env: Env, key: string, max: number, duration: number) {
  const t = now();
  const row = await env.DB.prepare('INSERT INTO login_limits (key,count,window_start,locked_until) VALUES (?,1,?,0) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<? THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END,locked_until=CASE WHEN window_start>=? AND count+1>=? THEN ? ELSE locked_until END RETURNING count,locked_until')
    .bind(key, t, t - duration, t - duration, t - duration, max, t + duration).first<{ count: number; locked_until: number }>();
  if (!row || row.locked_until > t || row.count > max) throw new AppError(429, '尝试过多，请稍后再试');
}
export async function login(request: Request, env: Env, input: Record<string, unknown>) {
  const username = String(input.username ?? '');
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const loginDetail = JSON.stringify({ ipHash: await sha256(ip), userAgent: (request.headers.get('User-Agent') ?? '').slice(0, 160) });
  try {
    await limit(env, `ip:${await sha256(ip)}`, 20, 900);
    await limit(env, `user:${await sha256(username.toLowerCase())}`, 6, 900);
  } catch (error) {
    await audit(env, null, null, 'auth.login', null, 'rate_limited', undefined, undefined, loginDetail);
    throw error;
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE username=?').bind(username).first<User>();
  let valid = false;
  if (user?.password_hash && user.password_salt && user.password_iterations && user.status === 'active' && user.locked_until <= now()) {
    valid = await verifyPassword(String(input.password ?? ''), user.password_salt, user.password_hash, user.password_iterations);
    if (valid && user.totp_enabled) valid = !!user.totp_secret && await verifyTotp(await decryptTotp(user.totp_secret, env.TOTP_KEY), String(input.totp ?? ''));
  }
  if (!valid || !user) {
    if (user) await env.DB.prepare('UPDATE users SET failed_count=failed_count+1,locked_until=CASE WHEN failed_count+1>=6 THEN ? ELSE locked_until END WHERE id=?').bind(now() + 900, user.id).run();
    await audit(env, user?.id ?? null, null, 'auth.login', null, 'failed', undefined, undefined, loginDetail);
    throw new AppError(401, '登录失败');
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET failed_count=0,locked_until=0 WHERE id=?').bind(user.id),
    env.DB.prepare('DELETE FROM login_limits WHERE key=?').bind(`user:${await sha256(username.toLowerCase())}`),
  ]);
  await audit(env, user.id, null, 'auth.login', null, 'success', undefined, undefined, loginDetail);
  return issueSession(env, user.id);
}
export async function acceptInvite(env: Env, input: Record<string, unknown>) {
  const token = String(input.token ?? '');
  const tokenHash = await sha256(token);
  const invite = await env.DB.prepare('SELECT user_id FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at>?').bind(tokenHash, now()).first<{ user_id: string }>();
  if (!invite) throw new AppError(400, '邀请无效或已过期');
  const username = validateUsername(input.username);
  const p = await hashPassword(String(input.password ?? ''));
  const used = await env.DB.prepare('UPDATE invitations SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING user_id').bind(now(), tokenHash, now()).first<{ user_id: string }>();
  if (!used) throw new AppError(400, '邀请无效或已过期');
  await env.DB.prepare("UPDATE users SET username=?,password_hash=?,password_salt=?,password_iterations=?,status='active' WHERE id=? AND status='pending'")
    .bind(username, p.hash, p.salt, p.iterations, used.user_id).run();
  await audit(env, used.user_id, null, 'auth.invite.accept', used.user_id, 'success');
  return issueSession(env, used.user_id);
}
export async function startTotp(env: Env, actor: Actor, currentPassword: string, currentCode?: string) {
  if (!actor.user.password_hash || !actor.user.password_salt || !actor.user.password_iterations || !await verifyPassword(currentPassword, actor.user.password_salt, actor.user.password_hash, actor.user.password_iterations)) throw new AppError(403, '当前密码无效');
  if (actor.user.totp_enabled) {
    if (!actor.user.totp_secret || !await verifyTotp(await decryptTotp(actor.user.totp_secret, env.TOTP_KEY), currentCode ?? '')) throw new AppError(403, '需验证当前 TOTP');
  }
  const secret = base32(bytes(20));
  await env.DB.prepare('UPDATE users SET totp_pending_secret=? WHERE id=?').bind(await encryptTotp(secret, env.TOTP_KEY), actor.user.id).run();
  const label = encodeURIComponent(`DNS Panel:${actor.user.username}`);
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=DNS%20Panel&algorithm=SHA1&digits=6&period=30` };
}
export async function finishTotp(env: Env, actor: Actor, code: string) {
  const row = await env.DB.prepare('SELECT totp_pending_secret FROM users WHERE id=?').bind(actor.user.id).first<{ totp_pending_secret: string | null }>();
  if (!row?.totp_pending_secret || !await verifyTotp(await decryptTotp(row.totp_pending_secret, env.TOTP_KEY), code)) throw new AppError(400, '验证码无效');
  await env.DB.prepare('UPDATE users SET totp_secret=totp_pending_secret,totp_pending_secret=NULL,totp_enabled=1 WHERE id=?').bind(actor.user.id).run();
  await audit(env, actor.user.id, null, 'auth.totp.enable', actor.user.id, 'success');
}
