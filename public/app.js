const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
const modeNames = { self:'默认：仅本人', collaborate:'协作：全量可见', delegate:'代管：全量读写', readonly:'只读：全量可见' };
const labels = { records:'DNS 记录', scopes:'授权范围', security:'账号安全', admin:'管理员', audit:'审计' };
const adminTasks = [['setup','域名与邀请'],['access','权限与范围'],['accounts','账号管理'],['operations','变更与对账']];
let me = null, csrf = '', zones = [], currentZone = '', currentTab = 'records', adminTask = 'setup', auditPage = 0;
let requestId = 0, initId = 0, themeMode = 'system';
let drafts = new Map(), ephemeral = { invite:'', recovery:'', totp:'' };
const mobileNavMedia = window.matchMedia('(max-width: 680px)');

function notice(message) {
  const node = $('#notice'); node.textContent = message; node.classList.add('show');
  clearTimeout(notice.timer); notice.timer = setTimeout(() => node.classList.remove('show'), 6000);
}
async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, credentials:'same-origin', cache:'no-store',
    headers:{ ...(data === undefined ? {} : {'Content-Type':'application/json'}), ...(method === 'GET' ? {} : {'X-CSRF-Token':csrf}) },
    body:data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function resetPrincipal() {
  requestId++; zones = []; currentZone = ''; currentTab = 'records'; adminTask = 'setup'; auditPage = 0;
  drafts = new Map(); ephemeral = { invite:'', recovery:'', totp:'' }; closeNav();
}
function busy(button, on, label) {
  if (!button) return;
  if (on) { button.dataset.label = button.textContent; button.disabled = true; button.setAttribute('aria-busy','true'); button.textContent += '…'; }
  else { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = label || button.dataset.label || button.textContent; delete button.dataset.label; }
}
async function onClick(button, action) {
  if (!button || button.disabled) return;
  const label = button.textContent; busy(button, true);
  try { await action(); } catch (error) { notice(error instanceof Error ? error.message : '操作失败'); }
  finally { if (button.isConnected) busy(button, false, label); }
}
function bindForm(id, action) {
  const form = document.getElementById(id); if (!form) return;
  form.onsubmit = async event => {
    event.preventDefault(); if (form.dataset.busy === 'true') return; form.dataset.busy = 'true';
    const button = form.querySelector('[type="submit"],button:not([type])'), label = button?.textContent || ''; busy(button, true);
    try { await action(new FormData(form), form); }
    catch (error) { notice(error instanceof Error ? error.message : '提交失败'); }
    finally { delete form.dataset.busy; if (button?.isConnected) busy(button, false, label); }
  };
}
function setTheme(mode) {
  themeMode = mode; document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('dns-panel-theme', mode); } catch {}
  const button = $('#theme-toggle');
  if (button) { const names = {system:'跟随系统',light:'浅色',dark:'深色'}; button.textContent = mode === 'system' ? '◐' : mode === 'light' ? '☼' : '☾'; button.setAttribute('aria-label',`外观：${names[mode]}。点击切换`); button.title = `外观：${names[mode]}`; }
}
function initTheme() {
  let saved = 'system';
  try { saved = localStorage.getItem('dns-panel-theme') || 'system'; } catch {}
  setTheme(['system','light','dark'].includes(saved) ? saved : 'system');
}
function cycleTheme() { setTheme(({system:'light',light:'dark',dark:'system'})[themeMode]); }
function syncNavMode() {
  const mobile = mobileNavMedia.matches;
  if (!mobile) document.body.classList.remove('nav-open');
  const open = mobile && document.body.classList.contains('nav-open');
  const sidebar = $('#sidebar');
  const focusWasInSidebar = !!sidebar?.contains(document.activeElement);
  if (sidebar) sidebar.inert = mobile && !open;
  $('#menu-toggle')?.setAttribute('aria-expanded',String(open));
  $('#nav-overlay')?.setAttribute('aria-hidden',String(!open));
  if (mobile && !open && focusWasInSidebar) $('#menu-toggle')?.focus();
}
if (mobileNavMedia.addEventListener) mobileNavMedia.addEventListener('change',syncNavMode);
else mobileNavMedia.addListener(syncNavMode);
function toggleNav(open) {
  document.body.classList.toggle('nav-open', open && mobileNavMedia.matches);
  syncNavMode();
  if (open && mobileNavMedia.matches) $('#nav-close')?.focus();
}
function closeNav(restoreFocus = false) {
  document.body.classList.remove('nav-open');
  syncNavMode();
  if (restoreFocus && !$('#menu-toggle')?.hidden) $('#menu-toggle')?.focus();
}
function isCurrent(id, zone = currentZone, tab = currentTab, principal = me?.id) { return id === requestId && zone === currentZone && tab === currentTab && principal === me?.id; }
function panel() { return $('#tab'); }
function loading(node = panel(), message = '正在加载…') {
  if (!node) return;
  node.setAttribute('aria-busy','true');
  node.innerHTML = `<div class="state-card" role="status"><span class="spinner" aria-hidden="true"></span><span>${esc(message)}</span></div>`;
}
function done(node = panel()) { node?.removeAttribute('aria-busy'); }
function errorState(node, error, retry) {
  if (!node) return; done(node);
  node.innerHTML = `<section class="card error-state"><h2>暂时无法加载</h2><p>${esc(error instanceof Error ? error.message : '请求失败')}</p><button type="button" class="secondary" data-retry>重试</button></section>`;
  $('[data-retry]',node).onclick = retry;
}
function empty(message) { return `<div class="empty-state"><span aria-hidden="true">—</span><p>${esc(message)}</p></div>`; }
function table(headers, rows, message = '暂无数据') {
  return `<div class="table-wrap" role="region" tabindex="0" aria-label="数据表格"><table><thead><tr>${headers.map(x => `<th scope="col">${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr class="empty-row"><td colspan="${headers.length}">${empty(message)}</td></tr>`}</tbody></table></div>`;
}
function secret(title, value, key) {
  return value ? `<div class="secret-result"><strong>${esc(title)}</strong><p>仅保存在当前页面内存中。请立即复制并安全转交。</p><pre>${esc(value)}</pre><button type="button" class="secondary" data-copy="${key}">复制链接</button></div>` : '';
}
function confirmAction(message) {
  const dialog = $('#confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('#confirm-message').textContent = message;
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once:true });
    dialog.returnValue = '';
    dialog.showModal();
    $('#confirm-cancel').focus();
  });
}
function bindCopy() {
  $$('[data-copy]').forEach(button => button.onclick = () => onClick(button, async () => {
    await navigator.clipboard.writeText(ephemeral[button.dataset.copy]); notice('链接已复制');
  }));
}
function inviteToken() {
  if (!location.hash.startsWith('#invite=')) return '';
  try { return decodeURIComponent(location.hash.slice(8)); } catch { return location.hash.slice(8); }
}
function showAuth(mode) {
  document.body.dataset.appState = 'auth'; closeNav(); $('#sidebar').hidden = true;
  $('#identity').textContent = ''; $('#menu-toggle').hidden = true; $('#app').className = 'auth-page';
  const invite = inviteToken(), isInvite = mode === 'invite' || !!invite;
  $('#app').innerHTML = `<section class="card auth-card"><div class="auth-mark" aria-hidden="true">D</div><p class="eyebrow">DNS CONTROL PANEL</p><h1>${isInvite ? '接受邀请' : mode === 'bootstrap' ? '创建管理员' : '登录'}</h1><p class="auth-intro">${isInvite ? '设置账号后即可管理获授权的 DNS 记录。' : mode === 'bootstrap' ? '创建首个管理员账号以开始配置。' : '登录后继续管理域名与授权范围。'}</p><form id="auth-form">
    ${isInvite ? `<label for="auth-token">邀请令牌</label><input id="auth-token" name="token" required autocomplete="off" value="${esc(invite)}">` : mode === 'bootstrap' ? '<label for="auth-key">引导密钥</label><input id="auth-key" name="key" type="password" required autocomplete="off">' : ''}
    <label for="auth-user">用户名</label><input id="auth-user" name="username" required autocomplete="username"><label for="auth-password">密码</label><input id="auth-password" name="password" type="password" required autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">${mode === 'login' ? '<label for="auth-totp">二次验证码（已开启时填写）</label><input id="auth-totp" name="totp" inputmode="numeric" autocomplete="one-time-code">' : ''}<button type="submit">${isInvite ? '设置账号' : mode === 'bootstrap' ? '创建管理员' : '登录'}</button></form></section>`;
  bindForm('auth-form', async values => {
    await api(isInvite ? '/api/invites/accept' : mode === 'bootstrap' ? '/api/bootstrap' : '/api/login','POST',Object.fromEntries(values.entries()));
    history.replaceState(null,'',location.pathname); me = null; resetPrincipal(); await init();
  });
}
async function init() {
  const seq = ++initId; let session;
  try { session = await api('/api/me'); }
  catch {
    if (seq !== initId) return; me = null; csrf = ''; resetPrincipal();
    const status = await api('/api/bootstrap/status').catch(() => ({needed:false}));
    if (seq === initId) showAuth(status.needed ? 'bootstrap' : 'login'); return;
  }
  if (seq !== initId) return;
  if (me && (me.id !== session.id || me.role !== session.role)) resetPrincipal();
  if (me?.role === 'admin' && session.role !== 'admin' && ['admin','audit'].includes(currentTab)) currentTab = 'records';
  me = session; csrf = session.csrf; document.body.dataset.appState = 'signed-in'; $('#menu-toggle').hidden = false;
  $('#identity').innerHTML = `<span class="identity-name">${esc(me.username)}</span><span class="role-badge">${me.role === 'admin' ? '管理员' : '用户'}</span><button type="button" id="logout" class="secondary compact">退出</button>`;
  $('#logout').onclick = () => onClick($('#logout'), async () => {
    await api('/api/logout','POST',{}); me = null; csrf = ''; initId++; resetPrincipal(); await init();
  });
  try { zones = await api('/api/zones'); if (seq !== initId) return; if (!zones.some(zone => zone.id === currentZone)) currentZone = zones[0]?.id || ''; }
  catch (error) {
    if (seq !== initId) return;
    document.body.dataset.appState = 'error'; $('#sidebar').hidden = true; $('#app').innerHTML = '<div id="tab"></div>'; errorState(panel(),error,init); return;
  }
  renderShell(); await loadTab();
}
function renderShell() {
  document.body.dataset.appState = 'signed-in'; $('#sidebar').hidden = false;
  const tabs = ['records','scopes','security',...(me.role === 'admin' ? ['admin','audit'] : [])];
  $('#sidebar').innerHTML = `<button type="button" id="nav-close" class="nav-close secondary">关闭导航</button><p class="sidebar-label">工作区</p><nav class="side-nav" aria-label="主要功能">${tabs.map(tab => `<button type="button" class="nav-item ${currentTab === tab ? 'active' : ''}" data-tab="${tab}" aria-current="${currentTab === tab ? 'page' : 'false'}"><span class="nav-dot" aria-hidden="true"></span>${labels[tab]}</button>`).join('')}</nav><div class="sidebar-divider"></div><label class="sidebar-label" for="zone-select">当前域名</label><select id="zone-select" aria-label="当前域名">${zones.map(zone => `<option value="${esc(zone.id)}" ${zone.id === currentZone ? 'selected' : ''}>${esc(zone.name)}</option>`).join('')}</select><p class="sidebar-footnote">${zones.length ? `${zones.length} 个可访问域名` : '管理员可在域名与邀请中添加域名'}</p>`;
  syncNavMode();
  $('#app').className = 'app-content';
  $('#app').innerHTML = `<header class="page-heading"><div><p class="eyebrow">DNS CONTROL PANEL</p><h1 id="page-title" tabindex="-1">${labels[currentTab]}</h1></div><p>${currentTab === 'records' ? '查看并安全管理当前域名的 DNS 记录。' : currentTab === 'scopes' ? '检查已授权名称范围与申请状态。' : currentTab === 'security' ? '管理登录凭据与双因素验证。' : currentTab === 'admin' ? '按任务配置域名、权限、账号与运行状态。' : '查看面板中的重要操作记录。'}</p></header><div id="tab" aria-live="polite"></div>`;
  $$('.nav-item').forEach(button => button.onclick = () => {
    currentTab = button.dataset.tab; closeNav(); renderShell(); $('#page-title')?.focus(); loadTab();
  });
  $('#zone-select').onchange = event => { currentZone = event.target.value; closeNav(); loadTab(); };
  $('#menu-toggle').onclick = () => toggleNav(true); $('#nav-close').onclick = () => closeNav(true);
  $('#nav-overlay').onclick = event => { if (event.target === $('#nav-overlay')) closeNav(true); };
  $('#theme-toggle').onclick = cycleTheme;
}
document.addEventListener('keydown', event => {
  if (!document.body.classList.contains('nav-open')) return;
  if (event.key === 'Escape') { closeNav(true); return; }
  if (event.key !== 'Tab') return;
  const sidebar = $('#sidebar');
  const items = $$('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]', sidebar);
  if (!items.length) { event.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (!sidebar.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
  else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
function needZone() {
  if (currentZone) return true;
  panel().innerHTML = '<section class="card"><h2>还没有可管理的域名</h2><p>请管理员先添加 Cloudflare Zone ID。</p></section>';
  done();
  return false;
}
async function loadTab() {
  const id = ++requestId, zone = currentZone, tab = currentTab, principal = me?.id;
  loading();
  try {
    if (tab === 'records') await renderRecords(id,zone,principal);
    else if (tab === 'scopes') await renderScopes(id,zone,principal);
    else if (tab === 'security') renderSecurity();
    else if (tab === 'admin' && me?.role === 'admin') await renderAdmin(id,zone,principal);
    else if (tab === 'audit' && me?.role === 'admin') await renderAudit(id,zone,principal);
    else { currentTab = 'records'; renderShell(); await loadTab(); }
  } catch (error) { if (isCurrent(id,zone,tab,principal)) errorState(panel(),error,loadTab); }
}
function recordRow(r) {
  return `<tr><td data-label="名称">${esc(r.name)}</td><td data-label="类型">${esc(r.type)}</td><td data-label="内容"><code>${esc(r.content || JSON.stringify(r.data || {}))}</code></td><td data-label="代理">${r.proxied ? '开启' : '关闭'}</td><td data-label="归属">${esc(r.owner_id || '管理员')}</td><td data-label="状态"><span class="status">${esc(r.drift_state || '正常')}</span></td><td data-label="操作" class="actions-cell"><button type="button" class="secondary" data-edit="${esc(r.id)}">编辑</button><button type="button" class="danger" data-delete="${esc(r.id)}">删除</button></td></tr>`;
}
function defaultRecord(zone) { return JSON.stringify({type:'A',name:`host.${zones.find(z => z.id === zone)?.name || 'example.com'}`,content:'192.0.2.1',ttl:1,proxied:false},null,2); }
async function renderRecords(id,zone,principal) {
  if (!needZone()) return;
  const [records,policy] = await Promise.all([api(`/api/records?zone=${encodeURIComponent(zone)}`),api(`/api/policies?zone=${encodeURIComponent(zone)}`)]);
  if (!isCurrent(id,zone,'records',principal)) return;
  const localDrafts = drafts, draft = localDrafts.get(zone) || {json:defaultRecord(zone),host:'',editing:null};
  let editingId = draft.editing;
  panel().innerHTML = `<section class="card"><div class="section-heading"><div><p class="eyebrow">ZONE RECORDS</p><h2>DNS 记录</h2></div><span class="count-badge">${records.length} 条</span></div>${policy ? `<p class="policy-note">策略：${esc(modeNames[policy.mode] || policy.mode)} · 上限 ${esc(policy.max_records)} · 可新增：${esc(policy.allowedTypes?.join('、') || '无')} · ${policy.require_approval ? '修改需审批' : '修改立即执行'}</p>` : ''}${table(['名称','类型','内容','代理','归属','状态','操作'],records.map(recordRow),'当前域名还没有 DNS 记录。')}</section>
  <div class="content-grid"><section class="card"><p class="eyebrow">JSON EDITOR</p><h2 id="editor-title">${editingId ? '编辑记录' : '创建记录'}</h2><p class="help-text">保留 Cloudflare DNS API 原始字段。复杂类型可填写 data 对象。</p><form id="record-form"><label for="record-json">记录 JSON</label><textarea id="record-json" required spellcheck="false">${esc(draft.json)}</textarea><button type="submit">提交变更</button><button type="button" id="editor-reset" class="secondary">清空编辑目标</button></form></section>
  <section class="card"><p class="eyebrow">CACHE</p><h2>清理缓存</h2><p class="help-text">按完整主机名提交缓存清理。</p><form id="purge-form"><label for="purge-host">主机名</label><input id="purge-host" name="host" required placeholder="host.example.com" value="${esc(draft.host)}"><button type="submit">按主机名清理</button></form></section></div>`;
  done();
  const editor = $('#record-json'), host = $('#purge-host');
  const saveDraft = () => localDrafts.set(zone,{json:editor.value,host:host.value,editing:editingId});
  editor.oninput = host.oninput = saveDraft;
  $$('[data-edit]').forEach(button => button.onclick = () => {
    const r = records.find(item => item.id === button.dataset.edit); if (!r) return;
    editingId = r.id; editor.value = JSON.stringify(Object.fromEntries(['type','name','content','data','ttl','priority','proxied','comment'].filter(k => r[k] !== undefined).map(k => [k,r[k]])),null,2);
    $('#editor-title').textContent = `编辑 ${r.name}`; saveDraft(); editor.focus();
  });
  $$('[data-delete]').forEach(button => button.onclick = () => onClick(button,async () => {
    if (!await confirmAction('确定删除这条 DNS 记录？')) return;
    const result = await api(`/api/records/${encodeURIComponent(button.dataset.delete)}`,'DELETE',{zoneId:zone});
    notice(result.pending ? '删除申请已提交审批' : '记录已删除');
    if (isCurrent(id,zone,'records',principal)) await loadTab();
  }));
  $('#editor-reset').onclick = () => { editingId = null; editor.value = defaultRecord(zone); $('#editor-title').textContent = '创建记录'; saveDraft(); };
  bindForm('record-form',async () => {
    let record; try { record = JSON.parse(editor.value); } catch { throw new Error('记录 JSON 格式无效，请检查后重试。'); }
    const rid = editingId;
    const result = await api(rid ? `/api/records/${encodeURIComponent(rid)}` : '/api/records',rid ? 'PATCH' : 'POST',{zoneId:zone,record});
    localDrafts.delete(zone); editingId = null; notice(result.pending ? '变更申请已提交审批' : 'DNS 变更已生效');
    if (isCurrent(id,zone,'records',principal)) await loadTab();
  });
  bindForm('purge-form',async data => { await api('/api/cache/purge','POST',{zoneId:zone,host:data.get('host')}); notice('已提交缓存清理'); });
}
async function renderScopes(id,zone,principal) {
  if (!needZone()) return;
  const [scopes,requests] = await Promise.all([api(`/api/scopes?zone=${encodeURIComponent(zone)}`),api('/api/scopes/requests')]);
  if (!isCurrent(id,zone,'scopes',principal)) return;
  const own = requests.filter(item => item.zone_id === zone);
  const reqRows = own.map(r => `<tr><td data-label="名称">${esc(r.name)}</td><td data-label="状态"><span class="status">${esc(r.status)}</span></td><td data-label="申请人">${esc(r.user_id)}</td><td data-label="操作">${me.role === 'admin' && r.status === 'pending' ? `<button type="button" data-approve="${esc(r.id)}">批准</button><button type="button" class="danger" data-reject="${esc(r.id)}">拒绝</button>` : '—'}</td></tr>`);
  panel().innerHTML = `<div class="content-grid"><section class="card"><p class="eyebrow">AUTHORIZED NAMES</p><h2>已授权名称范围</h2>${scopes.length ? `<div class="scope-list">${scopes.map(s => `<span class="pill">${esc(s.name)}${me.role === 'admin' ? `<small>${esc(s.user_id)}</small>` : ''}</span>`).join('')}</div>` : empty('当前域名还没有授权范围。')}</section>
  ${me.role === 'user' ? `<section class="card"><p class="eyebrow">REQUEST ACCESS</p><h2>申请子域名</h2><p class="help-text">申请获批前不会创建 DNS 记录。</p><form id="scope-form"><label for="scope-name">完整子域名</label><input id="scope-name" name="name" required placeholder="my.${esc(zones.find(z => z.id === zone)?.name)}"><button type="submit">提交申请</button></form></section>` : ''}</div>
  <section class="card"><div class="section-heading"><h2>申请历史</h2><span class="count-badge">${own.length} 条</span></div>${table(['名称','状态','申请人','操作'],reqRows,'当前域名还没有范围申请。')}</section>`;
  done();
  bindForm('scope-form',async data => { await api('/api/scopes/requests','POST',{zoneId:zone,name:data.get('name')}); notice('申请已提交，等待管理员审批'); if (isCurrent(id,zone,'scopes',principal)) await loadTab(); });
  for (const action of ['approve','reject']) $$(`[data-${action}]`).forEach(button => button.onclick = () => onClick(button,async () => {
    await api(`/api/admin/scopes/requests/${encodeURIComponent(button.dataset[action])}/${action}`,'POST',{});
    notice(action === 'approve' ? '范围申请已批准' : '范围申请已拒绝'); if (isCurrent(id,zone,'scopes',principal)) await loadTab();
  }));
}
function renderSecurity() {
  panel().innerHTML = `<div class="content-grid"><section class="card"><p class="eyebrow">TWO-FACTOR AUTHENTICATION</p><h2>双因素验证</h2><p class="setting-status"><span class="status-dot ${me.totpEnabled ? 'enabled' : ''}"></span>当前：${me.totpEnabled ? '已启用' : '未启用'}</p><p class="help-text">使用验证器应用中的动态验证码保护账号。</p><form id="totp-start"><label for="totp-password">当前密码</label><input id="totp-password" name="password" type="password" required autocomplete="current-password">${me.totpEnabled ? '<label for="totp-current-code">当前验证码</label><input id="totp-current-code" name="code" inputmode="numeric" required autocomplete="one-time-code">' : ''}<button type="submit">${me.totpEnabled ? '更换密钥' : '生成 TOTP 密钥'}</button></form><div id="totp-details">${ephemeral.totp ? `<div class="secret-result"><strong>验证器密钥</strong><pre>${esc(ephemeral.totp)}</pre><p>添加密钥后，输入当前验证码完成启用。</p><form id="totp-finish"><label for="totp-code">6 位验证码</label><input id="totp-code" name="code" inputmode="numeric" required autocomplete="one-time-code"><button type="submit">确认启用</button></form></div>` : ''}</div></section>
  <section class="card"><p class="eyebrow">PASSWORD</p><h2>修改密码</h2><p class="help-text">修改成功后，其他登录会话将被吊销。</p><form id="password-form"><label for="current-password">当前密码</label><input id="current-password" name="currentPassword" type="password" required autocomplete="current-password"><label for="new-password">新密码</label><input id="new-password" name="newPassword" type="password" required autocomplete="new-password"><label for="password-totp">TOTP（已启用时填写）</label><input id="password-totp" name="totp" inputmode="numeric" autocomplete="one-time-code"><button type="submit">修改密码</button></form></section></div>`;
  done();
  bindForm('totp-start',async data => {
    if (me.totpEnabled && !await confirmAction('更换密钥会使当前验证器失效。仍要继续吗？')) return;
    const principal = me?.id, startedFor = requestId, zone = currentZone;
    const result = await api('/api/totp/start','POST',Object.fromEntries(data.entries()));
    if (me?.id === principal) ephemeral.totp = result.secret;
    if (isCurrent(startedFor,zone,'security',principal)) renderSecurity();
    notice('密钥已生成，请添加到验证器并确认启用');
  });
  bindForm('totp-finish',async data => {
    const principal = me?.id;
    await api('/api/totp/finish','POST',{code:data.get('code')});
    if (me?.id === principal) { ephemeral.totp = ''; notice('TOTP 已启用'); await init(); }
  });
  bindForm('password-form',async data => {
    const principal = me?.id;
    await api('/api/password','POST',Object.fromEntries(data.entries()));
    notice('密码已修改，其他会话已吊销');
    if (me?.id === principal) await init();
  });
}
function renderAdminFrame() {
  panel().innerHTML = `<nav class="task-nav" aria-label="管理员任务">${adminTasks.map(([id,title]) => `<button type="button" class="task-tab ${adminTask === id ? 'active' : ''}" data-admin="${id}" aria-current="${adminTask === id ? 'page' : 'false'}">${title}</button>`).join('')}</nav><div id="admin-panel" aria-live="polite"></div>`;
  $$('[data-admin]').forEach(button => button.onclick = () => {
    adminTask = button.dataset.admin;
    $$('[data-admin]').forEach(item => { const active = item.dataset.admin === adminTask; item.classList.toggle('active',active); item.setAttribute('aria-current',String(active ? 'page' : 'false')); });
    loadAdmin(++requestId,currentZone,me?.id);
  });
}
async function renderAdmin(id,zone,principal) {
  if (!adminTasks.some(([key]) => key === adminTask)) adminTask = 'setup';
  renderAdminFrame(); await loadAdmin(id,zone,principal);
}
async function loadAdmin(id,zone,principal) {
  const node = $('#admin-panel'), task = adminTask; if (!node || me?.role !== 'admin') return;
  loading(node,'正在加载此任务所需的数据…');
  try {
    if (task === 'setup') renderSetup(node,id,zone,principal);
    else if (task === 'access') await renderAccess(node,id,zone,principal);
    else if (task === 'accounts') await renderAccounts(node,id,zone,principal);
    else await renderOperations(node,id,zone,principal);
  } catch (error) { if (isCurrent(id,zone,'admin',principal) && task === adminTask) errorState(node,error,() => loadAdmin(++requestId,zone,principal)); }
}
function renderSetup(node,id,zone,principal) {
  node.innerHTML = `<div class="content-grid"><section class="card"><p class="eyebrow">ADD A ZONE</p><h2>添加域名</h2><p class="help-text">输入 Cloudflare Zone ID，系统会验证域名。</p><form id="zone-form"><label for="zone-id">Cloudflare Zone ID</label><input id="zone-id" name="zoneId" required autocomplete="off"><button type="submit">添加并验证</button></form></section>
  <section class="card"><p class="eyebrow">INVITATION</p><h2>邀请用户</h2><p class="help-text">创建有效期为 24 小时的一次性邀请链接。</p><form id="invite-form"><label for="invite-zone">初始域名</label><select id="invite-zone" name="zoneId" ${zones.length ? '' : 'disabled'}>${zones.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('')}</select><button type="submit" ${zones.length ? '' : 'disabled'}>创建邀请链接</button></form><div id="invite-link">${secret('一次性邀请链接',ephemeral.invite,'invite')}</div></section></div>`;
  done(node); bindCopy();
  bindForm('zone-form',async data => { await api('/api/admin/zones','POST',{zoneId:data.get('zoneId')}); notice('域名已添加'); await init(); });
  bindForm('invite-form',async data => {
    const result = await api('/api/admin/invitations','POST',{zoneId:data.get('zoneId')});
    if (me?.id === principal) ephemeral.invite = result.link;
    const target = $('#invite-link');
    if (isCurrent(id,zone,'admin',principal) && adminTask === 'setup' && target) { target.innerHTML = secret('一次性邀请链接',ephemeral.invite,'invite'); bindCopy(); }
    notice('邀请链接已创建，请立即复制并安全转交');
  });
}
function userOptions(users) { return users.map(u => `<option value="${esc(u.id)}">${esc(u.username || u.id)}（${esc(u.status)}）</option>`).join(''); }
async function renderAccess(node,id,zone,principal) {
  const [users,policies,types] = await Promise.all([api('/api/admin/users'),api('/api/admin/policies'),api('/api/dns/types')]);
  if (!isCurrent(id,zone,'admin',principal) || adminTask !== 'access') return;
  const options = userOptions(users), rows = policies.map(p => `<tr><td data-label="用户">${esc(p.user_id)}</td><td data-label="域名">${esc(p.zone_id)}</td><td data-label="档位">${esc(modeNames[p.mode] || p.mode)}</td><td data-label="上限">${esc(p.max_records)}</td><td data-label="允许类型">${esc(p.allowedTypes.join('、') || '无')}</td><td data-label="代理 / 缓存 / 审批">${p.allow_proxy?'代理':'—'} / ${p.allow_purge?'缓存':'—'} / ${p.require_approval?'审批':'立即'}</td><td data-label="操作"><button type="button" class="danger" data-policy-user="${esc(p.user_id)}" data-policy-zone="${esc(p.zone_id)}">移除权限</button></td></tr>`);
  node.innerHTML = `<div class="content-grid"><section class="card"><p class="eyebrow">RECORD POLICY</p><h2>设置记录策略</h2><form id="policy-form"><label for="policy-user">用户</label><select id="policy-user" name="userId">${options}</select><label for="policy-zone">域名</label><select id="policy-zone" name="zoneId">${zones.map(z => `<option value="${esc(z.id)}" ${z.id===zone?'selected':''}>${esc(z.name)}</option>`).join('')}</select><label for="policy-mode">档位</label><select id="policy-mode" name="mode">${Object.entries(modeNames).map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}</select><label for="max-records">本人记录上限</label><input id="max-records" name="maxRecords" type="number" min="0" value="20" required><fieldset><legend>允许新增的记录类型</legend><div class="type-options">${types.map(t => `<label class="check-option"><input type="checkbox" name="allowedTypes" value="${esc(t)}"> ${esc(t)}</label>`).join('')}</div></fieldset><label class="check-option"><input name="allowProxy" type="checkbox"> 允许开启代理</label><label class="check-option"><input name="allowPurge" type="checkbox"> 允许清理缓存</label><label class="check-option"><input name="requireApproval" type="checkbox"> 变更需要审批</label><button type="submit">保存策略</button></form></section>
  <section class="card"><p class="eyebrow">AUTHORIZED NAMES</p><h2>直接分配子域名</h2><form id="assign-form"><label for="assign-user">用户</label><select id="assign-user" name="userId">${options}</select><label for="assign-name">完整子域名</label><input id="assign-name" name="name" required><button type="submit" ${zone?'':'disabled'}>分配当前域名范围</button></form><p class="help-text">代管档可由管理员分配整个域名作为临时写入范围。</p></section>
  <section class="card"><p class="eyebrow">RECORD OWNERSHIP</p><h2>转移记录归属</h2><form id="owner-form"><label for="owner-id">记录 ID</label><input id="owner-id" name="recordId" required><label for="owner-user">归属</label><select id="owner-user" name="userId"><option value="">管理员</option>${options}</select><button type="submit" ${zone?'':'disabled'}>转移当前域名记录</button></form></section></div><section class="card"><h2>现有策略</h2>${table(['用户','域名','档位','上限','允许类型','代理 / 缓存 / 审批','操作'],rows,'还没有配置策略。')}</section>`;
  done(node);
  const form = $('#policy-form'), fill = () => {
    const data = new FormData(form), p = policies.find(x => x.user_id===data.get('userId') && x.zone_id===data.get('zoneId'));
    form.elements.namedItem('mode').value = p?.mode || 'self'; form.elements.namedItem('maxRecords').value = p?.max_records ?? 20;
    for (const [f,k] of [['allowProxy','allow_proxy'],['allowPurge','allow_purge'],['requireApproval','require_approval']]) form.elements.namedItem(f).checked = !!p?.[k];
    const allowed = new Set(p?.allowedTypes ?? ['A','AAAA','CNAME','TXT']); $$('input[name="allowedTypes"]',form).forEach(x => x.checked = allowed.has(x.value));
  };
  form.elements.namedItem('userId').onchange = fill; form.elements.namedItem('zoneId').onchange = fill; if (users.length) fill();
  if (!users.length) {
    const guidance = document.createElement('p');
    guidance.className = 'help-text';
    guidance.textContent = '尚无用户账号。请先在“域名与邀请”创建用户邀请。';
    form.prepend(guidance);
    form.elements.namedItem('userId').disabled = true;
    form.querySelector('[type="submit"]').disabled = true;
    $('#assign-form').elements.namedItem('userId').disabled = true;
    $('#assign-form').querySelector('[type="submit"]').disabled = true;
  }
  bindForm('policy-form',async data => {
    if (!users.length) throw new Error('请先创建或邀请用户。');
    await api(`/api/admin/policies/${encodeURIComponent(data.get('userId'))}/${encodeURIComponent(data.get('zoneId'))}`,'PUT',{mode:data.get('mode'),maxRecords:Number(data.get('maxRecords')),allowProxy:data.has('allowProxy'),allowPurge:data.has('allowPurge'),requireApproval:data.has('requireApproval'),allowedTypes:data.getAll('allowedTypes')});
    notice('策略已保存'); if (isCurrent(id,zone,'admin',principal)) await loadAdmin(++requestId,zone,principal);
  });
  bindForm('assign-form',async data => {
    if (!users.length) throw new Error('请先创建或邀请用户。');
    if (!zone) throw new Error('请先选择当前域名。');
    await api('/api/admin/scopes','POST',{userId:data.get('userId'),zoneId:zone,name:data.get('name')}); notice('名称范围已分配'); if (isCurrent(id,zone,'admin',principal)) await loadAdmin(++requestId,zone,principal);
  });
  bindForm('owner-form',async data => {
    if (!zone) throw new Error('请先选择当前域名。');
    if (!await confirmAction('确认转移这条记录的归属？')) return;
    await api(`/api/admin/records/${encodeURIComponent(data.get('recordId'))}/owner`,'POST',{zoneId:zone,userId:data.get('userId') || null}); notice('记录归属已转移'); if (isCurrent(id,zone,'admin',principal)) await loadAdmin(++requestId,zone,principal);
  });
  $$('[data-policy-user]').forEach(button => button.onclick = () => onClick(button,async () => {
    if (!await confirmAction('确定移除此用户对该域名的全部面板权限？')) return;
    await api(`/api/admin/policies/${encodeURIComponent(button.dataset.policyUser)}/${encodeURIComponent(button.dataset.policyZone)}`,'DELETE',{});
    notice('该域名权限已移除'); if (isCurrent(id,zone,'admin',principal)) await loadAdmin(++requestId,zone,principal);
  }));
}
async function renderAccounts(node,id,zone,principal) {
  const users = await api('/api/admin/users');
  if (!isCurrent(id,zone,'admin',principal) || adminTask !== 'accounts') return;
  const rows = users.map(u => `<tr><td data-label="用户名">${esc(u.username || '未接受')}</td><td data-label="状态"><span class="status">${esc(u.status)}</span></td><td data-label="账号 ID"><code>${esc(u.id)}</code></td><td data-label="操作" class="actions-cell"><button type="button" data-user-action="${u.status==='disabled'?'enable':'disable'}" data-user-id="${esc(u.id)}">${u.status==='disabled'?'启用':'停用'}</button><button type="button" class="secondary" data-user-action="reset-password" data-user-id="${esc(u.id)}">重置密码</button><button type="button" class="secondary" data-user-action="reset-totp" data-user-id="${esc(u.id)}">重置 TOTP</button><button type="button" class="danger" data-user-action="delete" data-user-id="${esc(u.id)}">删除</button></td></tr>`);
  node.innerHTML = `<section class="card"><p class="eyebrow">ACCOUNTS</p><h2>账号</h2><p class="help-text">一次性找回链接仅保存在当前页面内存中，请及时复制。</p><div id="recovery-link">${secret('一次性找回链接',ephemeral.recovery,'recovery')}</div>${table(['用户名','状态','账号 ID','操作'],rows,'目前还没有其他用户账号。')}</section>`;
  done(node); bindCopy();
  $$('[data-user-action]').forEach(button => button.onclick = () => onClick(button,async () => {
    const action = button.dataset.userAction;
    if (action==='delete' && !await confirmAction('删除账号会收回权限并把记录归管理员。确定删除？')) return;
    if (action==='disable' && !await confirmAction('停用此账号会立即阻止登录。确定停用？')) return;
    const result = await api(`/api/admin/users/${encodeURIComponent(button.dataset.userId)}/${action}`,'POST',{});
    if (result.link) {
      if (me?.id === principal) ephemeral.recovery = result.link;
      const target = $('#recovery-link');
      if (isCurrent(id,zone,'admin',principal) && adminTask === 'accounts' && target) { target.innerHTML = secret('一次性找回链接',ephemeral.recovery,'recovery'); bindCopy(); }
      notice('找回链接已生成，请立即复制并安全转交'); return;
    }
    notice(action==='delete'?'账号已删除':'账号已更新'); if (isCurrent(id,zone,'admin',principal)) await loadAdmin(++requestId,zone,principal);
  }));
}
async function renderOperations(node,id,zone,principal) {
  if (!zone) { node.innerHTML = '<section class="card"><h2>选择域名以查看运行状态</h2><p>请先在侧栏选择域名。</p></section>'; done(node); return; }
  const [changes,drift,uncertain] = await Promise.all([api('/api/admin/changes'),api(`/api/admin/drift?zone=${encodeURIComponent(zone)}`),api(`/api/admin/operations?zone=${encodeURIComponent(zone)}`)]);
  if (!isCurrent(id,zone,'admin',principal) || adminTask!=='operations') return;
  const cRows = changes.map(x => `<tr><td data-label="类型">${esc(x.kind)}</td><td data-label="账号">${esc(x.user_id)}</td><td data-label="域名">${esc(x.zone_id)}</td><td data-label="内容"><pre>${esc(x.payload_json || x.record_id)}</pre></td><td data-label="操作"><button type="button" data-change="approve" data-id="${esc(x.id)}">批准</button><button type="button" class="danger" data-change="reject" data-id="${esc(x.id)}">拒绝</button></td></tr>`);
  const dRows = drift.map(x => `<tr><td data-label="记录 ID"><code>${esc(x.record_id)}</code></td><td data-label="归属">${esc(x.owner_id || '管理员')}</td><td data-label="状态">${esc(x.drift_state)}</td><td data-label="操作"><button type="button" data-drift="${x.drift_state==='missing'?'resolve-missing':'ack'}" data-id="${esc(x.record_id)}">${x.drift_state==='missing'?'确认已删除':'接受当前状态'}</button></td></tr>`);
  const oRows = uncertain.map(x => `<tr><td data-label="操作 ID"><code>${esc(x.id)}</code></td><td data-label="类型">${esc(x.kind)}</td><td data-label="记录">${esc(x.record_id)}</td><td data-label="错误">${esc(x.error)}</td><td data-label="操作"><button type="button" data-resolve="${esc(x.id)}">核对后关闭</button></td></tr>`);
  node.innerHTML = `<div class="content-grid"><section class="card"><p class="eyebrow">RECONCILIATION</p><h2>扫描当前域名</h2><p>检查 Cloudflare 状态并同步面板记录。</p><button type="button" id="reconcile">立即扫描</button><div id="reconcile-result"></div></section><section class="card"><p class="eyebrow">PENDING CHANGES</p><h2>待审批记录变更</h2>${table(['类型','账号','域名','内容','操作'],cRows,'没有待审批变更。')}</section></div>
  <section class="card"><h2>当前域名漂移</h2>${table(['记录 ID','归属','状态','操作'],dRows,'当前域名没有待处理漂移。')}</section><section class="card"><h2>结果待对账的操作</h2>${table(['操作 ID','类型','记录','错误','操作'],oRows,'当前域名没有待核对操作。')}</section>`;
  done(node);
  $('#reconcile').onclick = () => onClick($('#reconcile'),async () => {
    const result = await api('/api/admin/reconcile','POST',{zoneId:zone});
    if (isCurrent(id,zone,'admin',principal) && adminTask === 'operations') {
      const target = $('#reconcile-result');
      if (target) target.innerHTML = `<pre>${esc(JSON.stringify(result,null,2))}</pre>`;
    }
    notice('对账扫描已完成');
  });
  $$('[data-change]').forEach(button => button.onclick = () => onClick(button,async () => {
    const action = button.dataset.change; await api(`/api/admin/changes/${encodeURIComponent(button.dataset.id)}/${action}`,'POST',{});
    notice(action==='approve'?'变更已批准':'变更已拒绝'); if (isCurrent(id,zone,'admin',principal)) await loadAdmin(++requestId,zone,principal);
  }));
  $$('[data-drift]').forEach(button => button.onclick = () => onClick(button,async () => {
    await api(`/api/admin/records/${encodeURIComponent(button.dataset.id)}/${button.dataset.drift}`,'POST',{zoneId:zone});
    notice('漂移已处理'); if (isCurrent(id,zone,'admin',principal)) await loadAdmin(++requestId,zone,principal);
  }));
  $$('[data-resolve]').forEach(button => button.onclick = () => onClick(button,async () => {
    if (!await confirmAction('请先对照 Cloudflare 当前记录与审计内容。确认已人工核对并关闭此异常操作？')) return;
    await api(`/api/admin/operations/${encodeURIComponent(button.dataset.resolve)}/resolve`,'POST',{zoneId:zone});
    notice('异常操作已关闭'); if (isCurrent(id,zone,'admin',principal)) await loadAdmin(++requestId,zone,principal);
  }));
}
async function renderAudit(id,zone,principal) {
  const rows = await api(`/api/admin/audit?page=${auditPage}`);
  if (!isCurrent(id,zone,'audit',principal)) return;
  const body = rows.map(x => `<tr><td data-label="时间">${esc(new Date(x.created_at*1000).toLocaleString())}</td><td data-label="操作者">${esc(x.actor_id)}</td><td data-label="域名">${esc(x.zone_id)}</td><td data-label="动作">${esc(x.action)}</td><td data-label="对象">${esc(x.target_id)}</td><td data-label="结果">${esc(x.result)}</td><td data-label="详情"><details><summary>查看</summary><pre>${esc(JSON.stringify({before:x.before_json,after:x.after_json,detail:x.detail},null,2))}</pre></details></td></tr>`);
  panel().innerHTML = `<section class="card"><div class="section-heading"><h2>审计事件</h2><span class="count-badge">第 ${auditPage+1} 页</span></div>${table(['时间','操作者','域名','动作','对象','结果','详情'],body,'当前页没有审计记录。')}<div class="pagination"><button type="button" id="audit-prev" class="secondary" ${auditPage===0?'disabled':''}>上一页</button><button type="button" id="audit-next" class="secondary" ${rows.length<200?'disabled':''}>下一页</button></div></section>`;
  done(); $('#audit-prev').onclick = () => { auditPage = Math.max(0,auditPage-1); loadTab(); }; $('#audit-next').onclick = () => { auditPage++; loadTab(); };
}
initTheme();
init().catch(error => notice(error instanceof Error ? error.message : '初始化失败'));
