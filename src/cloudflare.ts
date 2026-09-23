import { AppError, type DnsRecord, type Env, type Zone } from './types';

interface CfResult<T> { success: boolean; errors?: { code: number; message: string }[]; result: T; result_info?: { page: number; total_pages: number } }
export async function cf<T>(env: Env, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${env.CF_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as CfResult<T>;
  if (!response.ok || !data.success) throw new AppError(502, 'Cloudflare 操作失败');
  return data.result;
}
export async function verifyZone(env: Env, zoneId: string): Promise<Zone> {
  const zone = await cf<{ id: string; name: string }>(env, `/zones/${encodeURIComponent(zoneId)}`);
  return { id: zone.id, name: zone.name.toLowerCase(), enabled: 1 };
}
export async function listRecords(env: Env, zoneId: string): Promise<DnsRecord[]> {
  const all: DnsRecord[] = [];
  for (let page = 1; page <= 10000; page++) {
    const response = await fetch(`${env.CF_API_BASE}/zones/${encodeURIComponent(zoneId)}/dns_records?page=${page}&per_page=500`, {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    });
    const data = await response.json() as CfResult<DnsRecord[]>;
    if (!response.ok || !data.success || !Array.isArray(data.result)) throw new AppError(502, 'Cloudflare 记录读取失败');
    all.push(...data.result);
    if (page >= (data.result_info?.total_pages ?? Number.MAX_SAFE_INTEGER) || data.result.length === 0 || (!data.result_info && data.result.length < 500)) return all;
  }
  throw new AppError(502, 'Cloudflare 记录数量超出面板安全上限');
}
export const getRecord = (env: Env, zone: string, record: string) => cf<DnsRecord>(env, `/zones/${encodeURIComponent(zone)}/dns_records/${encodeURIComponent(record)}`);
export const createRecord = (env: Env, zone: string, body: unknown) => cf<DnsRecord>(env, `/zones/${encodeURIComponent(zone)}/dns_records`, 'POST', body);
export const updateRecord = (env: Env, zone: string, record: string, body: unknown) => cf<DnsRecord>(env, `/zones/${encodeURIComponent(zone)}/dns_records/${encodeURIComponent(record)}`, 'PATCH', body);
export const deleteRecord = (env: Env, zone: string, record: string) => cf<{ id: string }>(env, `/zones/${encodeURIComponent(zone)}/dns_records/${encodeURIComponent(record)}`, 'DELETE');
export const purgeHost = (env: Env, zone: string, host: string) => cf<{ id: string }>(env, `/zones/${encodeURIComponent(zone)}/purge_cache`, 'POST', { hosts: [host] });
