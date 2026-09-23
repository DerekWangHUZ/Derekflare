import { AppError } from './types';

const encoder = new TextEncoder();
export const bytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64 = (s: string) => new Uint8Array([...atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4))].map(c => c.charCodeAt(0)));
export const randomToken = () => b64(bytes(32));
export async function sha256(value: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export async function hmac(key: string, value: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(value))));
}
export function equal(a: string, b: string): boolean {
  const x = encoder.encode(a), y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
export const PASSWORD_ITERATIONS = 600_000;
export async function hashPassword(password: string, salt = b64(bytes(16)), iterations = PASSWORD_ITERATIONS) {
  if (password.length < 12 || password.length > 256) throw new AppError(400, '密码长度需为 12–256 个字符');
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations }, key, 256);
  return { salt, hash: b64(new Uint8Array(hash)), iterations };
}
export async function verifyPassword(password: string, salt: string, expected: string, iterations: number) {
  if (password.length > 256) return false;
  try { return equal((await hashPassword(password, salt, iterations)).hash, expected); } catch { return false; }
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(data: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of data) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += alphabet[(value >>> (bits -= 5)) & 31]; } }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(input: string): Uint8Array {
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of input.toUpperCase()) { const n = alphabet.indexOf(c); if (n < 0) continue; value = (value << 5) | n; bits += 5; if (bits >= 8) out.push((value >>> (bits -= 8)) & 255); }
  return new Uint8Array(out);
}
async function aesKey(secret: string) {
  const raw = unb64(secret); if (raw.length !== 32) throw new Error('TOTP_KEY must be 32 random bytes in base64url');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptTotp(value: string, secret: string) {
  const iv = bytes(12); const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), encoder.encode(value));
  return `${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
}
export async function decryptTotp(value: string, secret: string) {
  const [iv, encrypted] = value.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(secret), unb64(encrypted)));
}
export async function verifyTotp(secret: string, code: string, time = Date.now()) {
  if (!/^\d{6}$/.test(code)) return false;
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(unbase32(secret)).buffer, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  for (let shift = -1; shift <= 1; shift++) {
    const counter = Math.floor(time / 30_000) + shift;
    const data = new Uint8Array(8); new DataView(data.buffer).setUint32(4, counter);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
    const offset = digest[19] & 15;
    const n = (((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000;
    if (equal(String(n).padStart(6, '0'), code)) return true;
  }
  return false;
}
