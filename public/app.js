const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
let me = null, csrf = '', zones = [], currentZone = '', users = [], currentTab = 'records', records = [], recordTypes = [], auditPage = 0;
const modeNames = { self:'默认：仅本人', collaborate:'协作：全量可见', delegate:'代管：全量读写', readonly:'只读：全量可见' };
function notice(message) { const n = $('#notice'); n.textContent = message; n.classList.add('show'); clearTimeout(notice.timer); notice.timer = setTimeout(() => n.classList.remove('show'), 6000); }
async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, credentials:'same-origin', headers:{ ...(data === undefined ? {} : {'Content-Type':'application/json'}), ...(method === 'GET' ? {} : {'X-CSRF-Token':csrf}) }, body:data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
async function refreshSession() {
  try { me = await api('/api/me'); csrf = me.csrf; return true; } catch { me = null; csrf = ''; return false; }
}
function showAuth(mode) {
  $('#identity').textContent = '';
  const invite = location.hash.startsWith('#invite=') ? decodeURIComponent(location.hash.slice(8)) : '';
  const isInvite = mode === 'invite' || !!invite;
  $('#app').innerHTML = `<section class="card auth"><h2>${isInvite ? '接受邀请' : mode === 'bootstrap' ? '创建管理员' : '登录'}</h2>
    <form id="auth-form">${isInvite ? `<label>邀请令牌</label><input name="token" required value="${esc(invite)}">` : mode === 'bootstrap' ? '<label>引导密钥</label><input name="key" type="password" required autocomplete="off">' : ''}
    <label>用户名</label><input name="username" required autocomplete="username"><label>密码</label><input name="password" type="password" required autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
    ${mode === 'login' ? '<label>二次验证码（已开启时填写）</label><input name="totp" inputmode="numeric" autocomplete="one-time-code">' : ''}
    <button type="submit">${isInvite ? '设置账号' : mode === 'bootstrap' ? '创建管理员' : '登录'}</button></form></section>`;
  $('#auth-form').onsubmit = async e => {
    e.preventDefault(); const values = Object.fromEntries(new FormData(e.target));
    try { await api(isInvite ? '/api/invites/accept' : mode === 'bootstrap' ? '/api/bootstrap' : '/api/login','POST',values); history.replaceState(null,'',location.pathname); await init(); }
    catch (error) { notice(error.message); }
  };
}
async function init() {
  if (!await refreshSession()) { const bootstrap = await api('/api/bootstrap/status').catch(() => ({ needed:false })); showAuth(bootstrap.needed ? 'bootstrap' : 'login'); return; }
  $('#identity').innerHTML = `<span>${esc(me.username)} · ${me.role === 'admin' ? '管理员' : '用户'}</span> <button id="logout" class="secondary">退出</button>`;
  $('#logout').onclick = async () => { try { await api('/api/logout','POST',{}); await init(); } catch (e) { notice(e.message); } };
  zones = await api('/api/zones'); if (!zones.some(z => z.id === currentZone)) currentZone = zones[0]?.id || '';
  recordTypes = await api('/api/dns/types');
  if (me.role === 'admin') users = await api('/api/admin/users');
  renderShell(); await loadTab();
}
function renderShell() {
  const tabs = ['records','scopes','security',...(me.role === 'admin' ? ['admin','audit'] : [])];
  const labels = { records:'DNS 记录',scopes:'子域名范围',security:'账号安全',admin:'管理员',audit:'审计' };
  $('#app').innerHTML = `<div class="card row"><label for="zone-select">当前域名</label><select id="zone-select">${zones.map(z => `<option value="${esc(z.id)}" ${z.id === currentZone ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></div>
    <nav class="tabs">${tabs.map(t => `<button data-tab="${t}" class="${t === currentTab ? 'active' : ''}">${labels[t]}</button>`).join('')}</nav><div id="tab"></div>`;
  $('#zone-select').onchange = async e => { currentZone = e.target.value; await loadTab(); };
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = async () => { currentTab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active',x.dataset.tab === currentTab)); await loadTab(); });
}
async function loadTab() { try { if (currentTab === 'records') await renderRecords(); else if (currentTab === 'scopes') await renderScopes(); else if (currentTab === 'security') renderSecurity(); else if (currentTab === 'admin') await renderAdmin(); else await renderAudit(); } catch (e) { $('#tab').innerHTML = `<div class="card">${esc(e.message)}</div>`; } }
function recordRow(r) { return `<tr><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td><code>${esc(r.content || JSON.stringify(r.data || {}))}</code></td><td>${esc(r.proxied ? '开启' : '关闭')}</td><td>${esc(r.owner_id || '管理员')}</td><td>${esc(r.drift_state)}</td><td><button class="secondary" data-edit="${esc(r.id)}">编辑</button><button class="danger" data-delete="${esc(r.id)}">删除</button></td></tr>`; }
async function renderRecords() {
  if (!currentZone) { $('#tab').innerHTML = '<div class="card">暂无域名，请管理员先添加 Zone ID。</div>'; return; }
  records = await api(`/api/records?zone=${encodeURIComponent(currentZone)}`);
  const policy = await api(`/api/policies?zone=${encodeURIComponent(currentZone)}`);
  $('#tab').innerHTML = `<div class="card"><h2>DNS 记录</h2>${policy ? `<p class="small">策略：${esc(modeNames[policy.mode])}；上限 ${esc(policy.max_records)}；可新增类型：${esc(policy.allowedTypes.length ? policy.allowedTypes.join('、') : '无')}；${policy.require_approval ? '修改需审批' : '修改立即执行'}</p>` : ''}
    <div class="scroll"><table><thead><tr><th>名称</th><th>类型</th><th>内容</th><th>代理</th><th>归属</th><th>状态</th><th>操作</th></tr></thead><tbody>${records.map(recordRow).join('')}</tbody></table></div></div>
    <div class="grid"><section class="card"><h2 id="editor-title">创建记录</h2><p class="small">使用 Cloudflare DNS API 的记录字段。复杂类型可填写 data 对象；面板会校验权限，Cloudflare 会校验类型专属字段。</p>
      <form id="record-form"><label>记录 JSON</label><textarea id="record-json" required>${esc(JSON.stringify({ type:'A', name:`host.${zones.find(z => z.id === currentZone)?.name}`, content:'192.0.2.1', ttl:1, proxied:false },null,2))}</textarea><button type="submit">提交</button><button type="button" id="editor-reset" class="secondary">清空编辑目标</button></form></section>
    <section class="card"><h2>清理缓存</h2><form id="purge-form"><label>主机名</label><input name="host" required placeholder="host.example.com"><button type="submit">按主机名清理</button></form></section></div>`;
  let editing = null;
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const r = records.find(x => x.id === b.dataset.edit); if (!r) return;
    editing = r.id; $('#editor-title').textContent = `编辑 ${r.name}`;
    $('#record-json').value = JSON.stringify(Object.fromEntries(['type','name','content','data','ttl','priority','proxied','comment'].filter(k => r[k] !== undefined).map(k => [k,r[k]])),null,2);
    $('#record-json').focus();
  });
  document.querySelectorAll('[data-delete]').forEach(b => b.onclick = async () => {
    if (!confirm('确定删除这条记录？')) return;
    try { const result = await api(`/api/records/${encodeURIComponent(b.dataset.delete)}`,'DELETE',{ zoneId:currentZone }); notice(result.pending ? '删除申请已提交审批' : '记录已删除'); await renderRecords(); } catch(e) { notice(e.message); }
  });
  $('#editor-reset').onclick = () => { editing = null; $('#editor-title').textContent = '创建记录'; };
  $('#record-form').onsubmit = async e => { e.preventDefault(); try {
    const record = JSON.parse($('#record-json').value);
    const result = await api(editing ? `/api/records/${encodeURIComponent(editing)}` : '/api/records',editing ? 'PATCH' : 'POST',{ zoneId:currentZone,record });
    notice(result.pending ? '变更申请已提交审批' : 'DNS 变更已生效'); await renderRecords();
  } catch(e) { notice(e.message); } };
  $('#purge-form').onsubmit = async e => { e.preventDefault(); try { await api('/api/cache/purge','POST',{ zoneId:currentZone,host:new FormData(e.target).get('host') }); notice('已提交缓存清理'); } catch(e) { notice(e.message); } };
}
async function renderScopes() {
  if (!currentZone) { $('#tab').innerHTML = '<div class="card">暂无域名</div>'; return; }
  const [scopes, requests] = await Promise.all([api(`/api/scopes?zone=${encodeURIComponent(currentZone)}`),api('/api/scopes/requests')]);
  $('#tab').innerHTML = `<div class="grid"><section class="card"><h2>已授权名称范围</h2>${scopes.length ? scopes.map(s => `<span class="pill">${esc(s.name)}${me.role === 'admin' ? ` · ${esc(s.user_id)}` : ''}</span>`).join('') : '<p class="small">尚未分配</p>'}</section>
    ${me.role === 'user' ? `<section class="card"><h2>申请子域名</h2><p class="small">申请获批前不会创建 DNS 记录。</p><form id="scope-form"><label>完整子域名</label><input name="name" required placeholder="my.${esc(zones.find(z => z.id === currentZone)?.name)}"><button type="submit">提交申请</button></form></section>` : ''}</div>
    <section class="card"><h2>申请历史</h2><table><tr><th>名称</th><th>状态</th><th>申请人</th><th>操作</th></tr>${requests.filter(r => r.zone_id === currentZone).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td>${esc(r.user_id)}</td><td>${me.role === 'admin' && r.status === 'pending' ? `<button data-scope-approve="${esc(r.id)}">批准</button><button class="danger" data-scope-reject="${esc(r.id)}">拒绝</button>` : ''}</td></tr>`).join('')}</table></section>`;
  if (me.role === 'user') $('#scope-form').onsubmit = async e => { e.preventDefault(); try { await api('/api/scopes/requests','POST',{ zoneId:currentZone,name:new FormData(e.target).get('name') }); notice('已提交，等待管理员审批'); await renderScopes(); } catch(e) { notice(e.message); } };
  for (const action of ['approve','reject']) document.querySelectorAll(`[data-scope-${action}]`).forEach(b => b.onclick = async () => { try { await api(`/api/admin/scopes/requests/${encodeURIComponent(b.dataset[`scope${action[0].toUpperCase()+action.slice(1)}`])}/${action}`,'POST',{}); notice('已处理'); await renderScopes(); } catch(e) { notice(e.message); } });
}
function renderSecurity() {
  $('#tab').innerHTML = `<div class="grid"><section class="card"><h2>双因素验证</h2><p>当前：${me.totpEnabled ? '已启用' : '未启用'}</p><button id="totp-start">生成 TOTP 密钥</button><div id="totp-details"></div></section>
  <section class="card"><h2>修改密码</h2><form id="password-form"><label>当前密码</label><input name="currentPassword" type="password" required><label>新密码</label><input name="newPassword" type="password" required><label>TOTP（已启用时填写）</label><input name="totp" inputmode="numeric"><button>修改并吊销旧会话</button></form></section></div>`;
  $('#totp-start').onclick = async () => { try { const password = prompt('输入当前密码以设置 TOTP'); if (!password) return; const code = me.totpEnabled ? prompt('输入当前 TOTP 验证码以更换密钥') : ''; if (me.totpEnabled && !code) return; const result = await api('/api/totp/start','POST',{ password,code }); $('#totp-details').innerHTML = `<p>在验证器中手动输入密钥：</p><pre>${esc(result.secret)}</pre><p class="small">请妥善保存；生成新密钥后，旧密钥会失效。</p><form id="totp-finish"><label>6 位验证码</label><input name="code" inputmode="numeric" required><button type="submit">确认启用</button></form>`; $('#totp-finish').onsubmit = async e => { e.preventDefault(); try { await api('/api/totp/finish','POST',{ code:new FormData(e.target).get('code') }); notice('TOTP 已启用'); await init(); } catch(err) { notice(err.message); } }; } catch(e) { notice(e.message); } };
  $('#password-form').onsubmit = async e => { e.preventDefault(); try { await api('/api/password','POST',Object.fromEntries(new FormData(e.target))); notice('密码已修改，其他会话已吊销'); await init(); } catch(err) { notice(err.message); } };
}
async function renderAdmin() {
  const [policies, changes, drift, uncertain] = await Promise.all([api('/api/admin/policies'),api('/api/admin/changes'),currentZone ? api(`/api/admin/drift?zone=${encodeURIComponent(currentZone)}`) : Promise.resolve([]),currentZone ? api(`/api/admin/operations?zone=${encodeURIComponent(currentZone)}`) : Promise.resolve([])]);
  const userOptions = users.map(u => `<option value="${esc(u.id)}">${esc(u.username || u.id)} (${esc(u.status)})</option>`).join('');
  $('#tab').innerHTML = `<div class="grid"><section class="card"><h2>添加域名</h2><form id="zone-form"><label>Cloudflare Zone ID</label><input name="zoneId" required><button>添加并验证</button></form></section>
    <section class="card"><h2>邀请用户</h2><form id="invite-form"><label>初始域名</label><select name="zoneId">${zones.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('')}</select><button>创建 24 小时邀请链接</button></form><div id="invite-link"></div></section>
    <section class="card"><h2>策略</h2><form id="policy-form"><label>用户</label><select name="userId">${userOptions}</select><label>域名</label><select name="zoneId">${zones.map(z => `<option value="${esc(z.id)}" ${z.id === currentZone ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select>
    <label>档位</label><select name="mode">${Object.entries(modeNames).map(([value,label]) => `<option value="${value}">${esc(label)}</option>`).join('')}</select><label>本人记录上限</label><input name="maxRecords" type="number" min="0" value="20" required>
    <label>允许新增的记录类型</label><div class="type-options">${recordTypes.map(type => `<label><input type="checkbox" name="allowedTypes" value="${esc(type)}"> ${esc(type)}</label>`).join('')}</div>
    <label><input name="allowProxy" type="checkbox"> 允许开启代理</label><label><input name="allowPurge" type="checkbox"> 允许清缓存</label><label><input name="requireApproval" type="checkbox"> 每次记录变更需审批</label><button>保存策略</button></form></section>
    <section class="card"><h2>直接分配子域名</h2><form id="assign-form"><label>用户</label><select name="userId">${userOptions}</select><label>完整子域名</label><input name="name" required><button>分配当前域名范围</button></form><p class="small">代管档可由管理员分配整个域名作为临时写入范围。</p></section>
    <section class="card"><h2>转移记录归属</h2><form id="owner-form"><label>记录 ID</label><input name="recordId" required><label>归属</label><select name="userId"><option value="">管理员</option>${userOptions}</select><button>转移当前域名记录</button></form></section>
    <section class="card"><h2>对账</h2><button id="reconcile">立即扫描当前域名</button><div id="reconcile-result"></div></section></div>
    <section class="card"><h2>账号</h2><div id="reset-link"></div><table><tr><th>用户名</th><th>状态</th><th>ID</th><th>操作</th></tr>${users.map(u => `<tr><td>${esc(u.username || '未接受')}</td><td>${esc(u.status)}</td><td><code>${esc(u.id)}</code></td><td><button data-user-action="${u.status === 'disabled' ? 'enable' : 'disable'}" data-user-id="${esc(u.id)}">${u.status === 'disabled' ? '启用' : '停用'}</button><button class="secondary" data-user-action="reset-password" data-user-id="${esc(u.id)}">重置密码</button><button class="secondary" data-user-action="reset-totp" data-user-id="${esc(u.id)}">重置 TOTP</button><button class="danger" data-user-action="delete" data-user-id="${esc(u.id)}">删除</button></td></tr>`).join('')}</table></section>
    <section class="card"><h2>待审批记录变更</h2><table><tr><th>类型</th><th>账号</th><th>域名</th><th>内容</th><th>操作</th></tr>${changes.map(c => `<tr><td>${esc(c.kind)}</td><td>${esc(c.user_id)}</td><td>${esc(c.zone_id)}</td><td><pre>${esc(c.payload_json || c.record_id)}</pre></td><td><button data-change-approve="${esc(c.id)}">批准</button><button class="danger" data-change-reject="${esc(c.id)}">拒绝</button></td></tr>`).join('')}</table></section>
    <section class="card"><h2>当前域名漂移</h2><table><tr><th>记录 ID</th><th>归属</th><th>状态</th><th>操作</th></tr>${drift.map(d => `<tr><td><code>${esc(d.record_id)}</code></td><td>${esc(d.owner_id || '管理员')}</td><td>${esc(d.drift_state)}</td><td><button data-drift-action="${d.drift_state === 'missing' ? 'resolve-missing' : 'ack'}" data-record-id="${esc(d.record_id)}">${d.drift_state === 'missing' ? '确认已删除' : '接受当前状态'}</button></td></tr>`).join('')}</table></section>
    <section class="card"><h2>结果待对账的操作</h2><table><tr><th>操作 ID</th><th>类型</th><th>记录</th><th>错误</th><th>操作</th></tr>${uncertain.map(o => `<tr><td><code>${esc(o.id)}</code></td><td>${esc(o.kind)}</td><td>${esc(o.record_id)}</td><td>${esc(o.error)}</td><td><button data-operation-resolve="${esc(o.id)}">核对后关闭</button></td></tr>`).join('')}</table></section>
    <section class="card"><h2>现有策略</h2><table><tr><th>用户</th><th>域名</th><th>档位</th><th>上限</th><th>允许类型</th><th>代理 / 缓存 / 审批</th><th>操作</th></tr>${policies.map(p => `<tr><td>${esc(p.user_id)}</td><td>${esc(p.zone_id)}</td><td>${esc(modeNames[p.mode])}</td><td>${esc(p.max_records)}</td><td>${esc(p.allowedTypes.join('、') || '无')}</td><td>${p.allow_proxy}/${p.allow_purge}/${p.require_approval}</td><td><button class="danger" data-policy-user="${esc(p.user_id)}" data-policy-zone="${esc(p.zone_id)}">移除权限</button></td></tr>`).join('')}</table></section>`;
  const policyForm = $('#policy-form');
  const fillPolicy = () => { const f = new FormData(policyForm), current = policies.find(p => p.user_id === f.get('userId') && p.zone_id === f.get('zoneId')); policyForm.elements.namedItem('mode').value = current?.mode || 'self'; policyForm.elements.namedItem('maxRecords').value = current?.max_records ?? 20; for (const [field,key] of [['allowProxy','allow_proxy'],['allowPurge','allow_purge'],['requireApproval','require_approval']]) policyForm.elements.namedItem(field).checked = !!current?.[key]; const selected = new Set(current?.allowedTypes ?? ['A','AAAA','CNAME','TXT']); policyForm.querySelectorAll('input[name="allowedTypes"]').forEach(box => { box.checked = selected.has(box.value); }); };
  policyForm.elements.namedItem('userId').onchange = fillPolicy; policyForm.elements.namedItem('zoneId').onchange = fillPolicy; fillPolicy();
  $('#zone-form').onsubmit = async e => { e.preventDefault(); try { await api('/api/admin/zones','POST',{ zoneId:new FormData(e.target).get('zoneId') }); notice('域名已添加'); await init(); } catch(err) { notice(err.message); } };
  $('#invite-form').onsubmit = async e => { e.preventDefault(); try { const result = await api('/api/admin/invitations','POST',{ zoneId:new FormData(e.target).get('zoneId') }); $('#invite-link').innerHTML = `<p>仅显示一次，请复制后发给用户：</p><pre>${esc(result.link)}</pre>`; users = await api('/api/admin/users'); } catch(err) { notice(err.message); } };
  $('#policy-form').onsubmit = async e => { e.preventDefault(); const f = e.target, form = new FormData(f); try { await api(`/api/admin/policies/${encodeURIComponent(form.get('userId'))}/${encodeURIComponent(form.get('zoneId'))}`,'PUT',{ mode:form.get('mode'),maxRecords:Number(form.get('maxRecords')),allowProxy:form.has('allowProxy'),allowPurge:form.has('allowPurge'),requireApproval:form.has('requireApproval'),allowedTypes:form.getAll('allowedTypes') }); notice('策略已保存'); await renderAdmin(); } catch(err) { notice(err.message); } };
  $('#assign-form').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); try { await api('/api/admin/scopes','POST',{ userId:f.get('userId'),zoneId:currentZone,name:f.get('name') }); notice('范围已分配'); await renderAdmin(); } catch(err) { notice(err.message); } };
  $('#owner-form').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); try { await api(`/api/admin/records/${encodeURIComponent(f.get('recordId'))}/owner`,'POST',{ zoneId:currentZone,userId:f.get('userId') || null }); notice('归属已转移'); await renderAdmin(); } catch(err) { notice(err.message); } };
  $('#reconcile').onclick = async () => { try { const result = await api('/api/admin/reconcile','POST',{ zoneId:currentZone }); $('#reconcile-result').innerHTML = `<pre>${esc(JSON.stringify(result,null,2))}</pre>`; } catch(e) { notice(e.message); } };
  document.querySelectorAll('[data-user-action]').forEach(b => b.onclick = async () => { if (b.dataset.userAction === 'delete' && !confirm('删除账号会收回权限并把记录归管理员，确定吗？')) return; try { const result = await api(`/api/admin/users/${encodeURIComponent(b.dataset.userId)}/${b.dataset.userAction}`,'POST',{}); if (result.link) { $('#reset-link').innerHTML = `<p>一次性找回链接：</p><pre>${esc(result.link)}</pre>`; } else { notice('账号已更新'); await init(); } } catch(e) { notice(e.message); } });
  for (const action of ['approve','reject']) document.querySelectorAll(`[data-change-${action}]`).forEach(b => b.onclick = async () => { try { await api(`/api/admin/changes/${encodeURIComponent(b.dataset[`change${action[0].toUpperCase()+action.slice(1)}`])}/${action}`,'POST',{}); notice('审批已处理'); await renderAdmin(); } catch(e) { notice(e.message); } });
  document.querySelectorAll('[data-drift-action]').forEach(b => b.onclick = async () => { try { await api(`/api/admin/records/${encodeURIComponent(b.dataset.recordId)}/${b.dataset.driftAction}`,'POST',{zoneId:currentZone}); notice('漂移已处理'); await renderAdmin(); } catch(e) { notice(e.message); } });
  document.querySelectorAll('[data-policy-user]').forEach(b => b.onclick = async () => { if (!confirm('确定移除此人对该域名的全部面板权限？')) return; try { await api(`/api/admin/policies/${encodeURIComponent(b.dataset.policyUser)}/${encodeURIComponent(b.dataset.policyZone)}`,'DELETE',{}); notice('该域名权限已移除'); await renderAdmin(); } catch(e) { notice(e.message); } });
  document.querySelectorAll('[data-operation-resolve]').forEach(b => b.onclick = async () => { if (!confirm('请先对照 Cloudflare 当前记录与审计内容。确认已人工核对并关闭此异常操作？')) return; try { await api(`/api/admin/operations/${encodeURIComponent(b.dataset.operationResolve)}/resolve`,'POST',{zoneId:currentZone}); notice('异常操作已关闭'); await renderAdmin(); } catch(e) { notice(e.message); } });
}
async function renderAudit() { const rows = await api(`/api/admin/audit?page=${auditPage}`); $('#tab').innerHTML = `<section class="card"><h2>审计事件 · 第 ${auditPage + 1} 页</h2><table><tr><th>时间</th><th>操作者</th><th>域名</th><th>动作</th><th>对象</th><th>结果</th><th>详情</th></tr>${rows.map(r => `<tr><td>${esc(new Date(r.created_at*1000).toLocaleString())}</td><td>${esc(r.actor_id)}</td><td>${esc(r.zone_id)}</td><td>${esc(r.action)}</td><td>${esc(r.target_id)}</td><td>${esc(r.result)}</td><td><details><summary>查看</summary><pre>${esc(JSON.stringify({before:r.before_json,after:r.after_json,detail:r.detail},null,2))}</pre></details></td></tr>`).join('')}</table><button id="audit-prev" class="secondary" ${auditPage === 0 ? 'disabled' : ''}>上一页</button><button id="audit-next" class="secondary" ${rows.length < 200 ? 'disabled' : ''}>下一页</button></section>`; $('#audit-prev').onclick = async () => { auditPage--; await renderAudit(); }; $('#audit-next').onclick = async () => { auditPage++; await renderAudit(); }; }
init().catch(e => notice(e.message));
