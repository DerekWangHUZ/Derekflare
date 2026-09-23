export type Env = Cloudflare.Env;

export type Mode = 'self' | 'collaborate' | 'delegate' | 'readonly';
export interface User {
  id: string; username: string | null; password_hash: string | null;
  password_salt: string | null; password_iterations: number | null;
  role: 'admin' | 'friend'; status: 'pending' | 'active' | 'disabled';
  totp_secret: string | null; totp_enabled: number;
  failed_count: number; locked_until: number;
}
export interface Zone { id: string; name: string; enabled: number }
export interface Policy {
  user_id: string; zone_id: string; mode: Mode; max_records: number;
  allow_proxy: number; allow_purge: number; require_approval: number;
}
export interface DnsRecord {
  id: string; name: string; type: string; content?: string; data?: Record<string, unknown>;
  ttl: number; proxied?: boolean; proxiable?: boolean; priority?: number;
  comment?: string; tags?: string[]; modified_on?: string;
  [key: string]: unknown;
}
export interface Actor { user: User; sessionId: string; csrfHash: string }

export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const now = () => Math.floor(Date.now() / 1000);
export const id = () => crypto.randomUUID();
