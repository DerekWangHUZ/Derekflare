import http from 'node:http';
import { randomUUID } from 'node:crypto';

const records = new Map([['admin-record', { id:'admin-record', name:'owner.example.test', type:'A', content:'192.0.2.10', ttl:1, proxied:false, proxiable:true, tags:[], modified_on:'2026-01-01T00:00:00Z' }]]);
let serial = 1;
const send = (res, result, status = 200, extra = {}) => { res.writeHead(status, { 'Content-Type':'application/json' }); res.end(JSON.stringify({ success:status < 400, errors:status < 400 ? [] : [{code:1000,message:'mock error'}], result, ...extra })); };
http.createServer(async (req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8999');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'client' || parts[1] !== 'v4' || parts[2] !== 'zones' || parts[3] !== 'test-zone') return send(res, null, 404);
  if (parts.length === 4 && req.method === 'GET') return send(res, { id:'test-zone', name:'example.test' });
  if (parts[4] === 'purge_cache' && req.method === 'POST') return send(res, { id:'purge-1' });
  if (parts[4] !== 'dns_records') return send(res, null, 404);
  const body = await new Promise(resolve => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } }); });
  if (parts.length === 5 && req.method === 'GET') return send(res, [...records.values()], 200, { result_info:{ page:1,total_pages:1 } });
  if (parts.length === 5 && req.method === 'POST') {
    const id = randomUUID(); const record = { ...body, id, modified_on:new Date(Date.now() + serial++).toISOString(), proxiable:['A','AAAA','CNAME'].includes(body.type) };
    records.set(id, record); return send(res, record);
  }
  const id = parts[5], old = records.get(id);
  if (!old) return send(res, null, 404);
  if (req.method === 'GET') return send(res, old);
  if (req.method === 'PATCH') { const updated = { ...old, ...body, modified_on:new Date(Date.now() + serial++).toISOString() }; records.set(id,updated); return send(res,updated); }
  if (req.method === 'DELETE') { records.delete(id); return send(res,{ id }); }
  return send(res,null,405);
}).listen(8999,'127.0.0.1',() => process.stdout.write('mock Cloudflare ready\n'));
