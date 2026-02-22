const API = location.origin;
let PW = localStorage.getItem('proxy_login_secret') || '';
let startTime = Date.now();
let chatHistory = [];
let currentProto = 'openai';
let allModels = [];
let modelFilter = 'all';
let showExcluded = false;

function $(id) { return document.getElementById(id); }

// ========== Login gate ==========
async function doLogin() {
  const secret = $('loginInput').value.trim();
  if (!secret) return;
  try {
    const r = await fetch(API + '/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    const d = await r.json();
    if (d.valid) {
      PW = secret;
      localStorage.setItem('proxy_login_secret', secret);
      $('loginOverlay').style.display = 'none';
      $('loginError').style.display = 'none';
      loadAll();
    } else {
      $('loginError').textContent = '密钥错误';
      $('loginError').style.display = 'block';
    }
  } catch {
    $('loginError').textContent = '连接失败';
    $('loginError').style.display = 'block';
  }
}

async function checkLogin() {
  try {
    const r = await fetch(API + '/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: PW }),
    });
    const d = await r.json();
    if (!d.valid) {
      $('loginOverlay').style.display = 'flex';
      $('loginInput').focus();
      return false;
    }
    return true;
  } catch {
    return true; // Can't reach server, let rpc calls show errors naturally
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const loggedIn = await checkLogin();
  if (loggedIn) loadAll();
  setInterval(updateUptime, 1000);
  $('chatTemp').addEventListener('input', (e) => $('tempValue').textContent = e.target.value);
  $('sysPort').textContent = location.port || (location.protocol === 'https:' ? '443' : '80');
  if (isRemoteAccess()) $('remoteAccessHint').style.display = 'block';
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) toggleAddMenu(false);
  });

  // Listen for auth-complete from new-tab OAuth flow
  window.addEventListener('message', (e) => {
    // Accept same origin + localhost origins (for Codex OAuth on port 1455)
    const sameOrigin = e.origin === location.origin;
    const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(e.origin);
    if (!sameOrigin && !localOrigin) return;
    if (e.data?.type === 'auth-complete') {
      toast('认证完成', 'success');
      loadCredentials();
      checkAuth();
    }
  });
});

function toast(msg, type = 'info', duration = 3000) {
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  $('toastBox').appendChild(d);
  setTimeout(() => d.remove(), duration);
}

function go(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $(`page-${page}`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  if (page === 'models') loadModels();
  if (page === 'manage') loadCredentials();
  if (page === 'logs') startLogStream();
}

async function rpc(ep, opts = {}) {
  try {
    const headers = { 'Authorization': 'Bearer ' + PW, ...opts.headers };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(API + ep, { ...opts, headers });
    const txt = await r.text();
    let d;
    try { d = JSON.parse(txt); } catch { d = { raw: txt }; }
    return { ok: r.ok, data: d, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function loadAll() {
  await Promise.all([checkAuth(), loadModels(), loadCredentials(), loadStats(), loadAuthSettings()]);
}

function refreshAll() {
  loadAll();
  toast('已刷新', 'success');
}

// ========== Auth ==========
async function checkAuth() {
  const r = await rpc('/auth/status');
  const has = r.data?.hasCredentials || false;
  const expired = r.data?.isExpired || false;
  const account = r.data?.accountId || null;

  const dot = $('statusDot');
  const text = $('statusText');
  if (has && !expired) {
    dot.className = 'status-dot online';
    text.textContent = '已连接';
  } else if (has && expired) {
    dot.className = 'status-dot warning';
    text.textContent = '已过期';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = '未连接';
  }

  const avatar = $('authAvatar');
  const title = $('authTitle');
  const desc = $('authDesc');
  if (has) {
    avatar.className = 'auth-avatar connected';
    avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>';
    title.textContent = account ? `已登录 · ${account}` : '已登录';
    desc.textContent = expired ? '凭证已过期，请重新登录' : '点击下方卡片添加更多 Provider';
  } else {
    avatar.className = 'auth-avatar disconnected';
    avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    title.textContent = '未认证';
    desc.textContent = '点击下方卡片开始 OAuth 授权流程';
  }

  // Update provider status
  const creds = await rpc('/auth/accounts');
  const accounts = creds.data?.accounts || [];
  const counts = { gemini: 0, codex: 0, iflow: 0 };
  accounts.forEach(c => {
    const p = c.provider || 'gemini';
    if (counts[p] !== undefined) counts[p]++;
  });

  updateProviderStatus('statusGemini', counts.gemini);
  updateProviderStatus('statusCodex', counts.codex);
  updateProviderStatus('statusIflow', counts.iflow);
}

function updateProviderStatus(id, count) {
  const el = $(id);
  if (count > 0) {
    el.className = 'provider-status connected';
    el.innerHTML = `<span class="dot"></span>${count} 个凭证`;
  } else {
    el.className = 'provider-status';
    el.innerHTML = `<span class="dot"></span>未连接`;
  }
}

function isRemoteAccess() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
  if (/^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h)) return false;
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return false;
  return true;
}

function startAuth(provider) {
  if (isRemoteAccess()) {
    showRemoteAuthModal(provider);
    return;
  }
  const url = provider === 'codex' ? API + '/auth/codex/login'
    : provider === 'iflow' ? API + '/auth/iflow/login'
    : API + '/auth/login';
  window.open(url, '_blank');
}

let remoteAuthProvider = '';

async function showRemoteAuthModal(provider) {
  const backendProvider = provider === 'google' ? 'gemini' : provider;
  remoteAuthProvider = backendProvider;

  $('remoteAuthError').style.display = 'none';
  $('remoteAuthSuccess').style.display = 'none';
  $('remoteCallbackUrl').value = '';
  $('remoteAuthLink').textContent = '加载中...';
  $('remoteAuthLink').href = '#';
  $('remoteSubmitBtn').disabled = false;
  $('remoteSubmitBtn').textContent = '提交';
  $('remoteAuthModal').style.display = 'flex';

  try {
    const r = await rpc('/auth/remote/init?provider=' + encodeURIComponent(backendProvider));
    if (!r.ok) {
      $('remoteAuthError').textContent = r.data?.error || '初始化失败';
      $('remoteAuthError').style.display = 'block';
      return;
    }
    $('remoteAuthLink').href = r.data.authUrl;
    $('remoteAuthLink').textContent = '点击此处打开授权页面 →';
  } catch (e) {
    $('remoteAuthError').textContent = '请求失败: ' + e.message;
    $('remoteAuthError').style.display = 'block';
  }
}

async function submitRemoteCallback() {
  const callbackUrl = $('remoteCallbackUrl').value.trim();
  if (!callbackUrl) {
    $('remoteAuthError').textContent = '请粘贴回调 URL';
    $('remoteAuthError').style.display = 'block';
    return;
  }

  if (!/^https?:\/\/localhost[:/]/.test(callbackUrl)) {
    $('remoteAuthError').textContent = 'URL 应以 http://localhost 开头';
    $('remoteAuthError').style.display = 'block';
    return;
  }

  $('remoteAuthError').style.display = 'none';
  $('remoteAuthSuccess').style.display = 'none';
  $('remoteSubmitBtn').disabled = true;
  $('remoteSubmitBtn').textContent = '提交中...';

  try {
    const r = await rpc('/auth/remote/exchange', {
      method: 'POST',
      body: JSON.stringify({ provider: remoteAuthProvider, callbackUrl }),
    });
    if (r.ok && r.data?.success) {
      $('remoteAuthSuccess').textContent = '认证成功: ' + r.data.accountId;
      $('remoteAuthSuccess').style.display = 'block';
      toast('认证完成: ' + r.data.accountId, 'success');
      loadCredentials();
      checkAuth();
      setTimeout(() => closeRemoteAuth(), 2000);
    } else {
      $('remoteAuthError').textContent = r.data?.error || '认证失败';
      $('remoteAuthError').style.display = 'block';
    }
  } catch (e) {
    $('remoteAuthError').textContent = '请求失败: ' + e.message;
    $('remoteAuthError').style.display = 'block';
  } finally {
    $('remoteSubmitBtn').disabled = false;
    $('remoteSubmitBtn').textContent = '提交';
  }
}

function closeRemoteAuth() {
  $('remoteAuthModal').style.display = 'none';
  remoteAuthProvider = '';
}

// ========== Stats ==========
async function loadStats() {
  const r = await rpc('/v0/management/stats');
  if (!r.ok) return;
  const d = r.data;

  $('sysBackend').textContent = d.backend || '-';
  $('sysStrategy').textContent = d.routing_strategy || '-';
  $('statRequests').textContent = d.total_requests || 0;

  // Calibrate uptime from server
  if (d.uptime_seconds) startTime = Date.now() - d.uptime_seconds * 1000;

  // Sync provider toggle states
  if (d.providers) {
    $('toggleCodex').checked = !!d.providers.codex;
    $('toggleIflow').checked = !!d.providers.iflow;
  }
}

function updateUptime() {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  $('statUptime').textContent = `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ========== Models ==========
async function loadModels() {
  const url = showExcluded ? '/v1/models?include_excluded=true' : '/v1/models';
  const r = await rpc(url);
  allModels = r.data?.data || [];

  // Count only non-excluded models for stats
  const activeModels = allModels.filter(m => !m.x_excluded);
  $('statModels').textContent = activeModels.length;

  // Chat dropdown only shows non-excluded models
  const sel = $('chatModel');
  sel.innerHTML = activeModels.map(m => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');

  renderModels();
}

function renderModels() {
  const list = $('modelList');
  const filtered = modelFilter === 'all' ? allModels : allModels.filter(m => (m.x_provider || 'gemini') === modelFilter);

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg><p>暂无模型</p></div>';
    return;
  }

  const groups = {};
  filtered.forEach(m => {
    const p = m.x_provider || 'gemini';
    if (!groups[p]) groups[p] = [];
    groups[p].push(m);
  });

  let html = '';
  const order = ['gemini', 'codex', 'iflow'];
  const labels = { gemini: 'Gemini', codex: 'Codex', iflow: 'iFlow' };

  order.forEach(p => {
    if (!groups[p]) return;
    const activeCount = groups[p].filter(m => !m.x_excluded).length;
    const totalCount = groups[p].length;
    const countLabel = showExcluded && activeCount !== totalCount ? `${activeCount}/${totalCount}` : `${totalCount}`;
    html += `<div style="margin-bottom: 20px;">
      <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">${labels[p]} · ${countLabel} 个模型</div>`;
    groups[p].forEach(m => {
      const isExcluded = !!m.x_excluded;
      const excludedClass = isExcluded ? ' excluded' : '';
      // Extract the model name without provider prefix
      const modelName = m.id.includes('/') ? m.id.split('/').slice(1).join('/') : m.id;
      const provider = m.x_provider || 'gemini';
      const actionLabel = isExcluded ? '显示' : '隐藏';
      const actionType = isExcluded ? 'remove' : 'add';
      const excludedTag = isExcluded ? ' <span style="font-size:10px;color:var(--accent-warning);">(已隐藏)</span>' : '';
      html += `<div class="model-item${excludedClass}" onclick="selectModel('${esc(m.id)}')">
        <span class="model-name">${esc(m.id)}${excludedTag}</span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="model-badge ${p}">${labels[p]}</span>
          <button class="model-hide-btn" onclick="event.stopPropagation();toggleModelExclude('${esc(provider)}','${esc(modelName)}','${actionType}')">${actionLabel}</button>
        </span>
      </div>`;
    });
    html += '</div>';
  });
  list.innerHTML = html;
}

function filterModels(f) {
  modelFilter = f;
  document.querySelectorAll('#modelFilter .protocol-tab').forEach(t => t.classList.toggle('active', t.dataset.pf === f));
  renderModels();
}

function selectModel(id) {
  go('chat');
  $('chatModel').value = id;
}

// ========== Credentials ==========
async function loadCredentials() {
  const r = await rpc('/auth/accounts');
  const accounts = r.data?.accounts || [];

  $('statAccounts').textContent = accounts.length;

  const list = $('credentialList');
  const hasProxy = accounts.some(c => c.proxy_url);

  const provDefs = [
    { key: 'gemini', label: 'Gemini', badge: 'gemini', authFn: 'google', btnLabel: 'Google 登录' },
    { key: 'codex', label: 'Codex', badge: 'codex', authFn: 'codex', btnLabel: 'Codex 登录' },
    { key: 'iflow', label: 'iFlow', badge: 'iflow', authFn: 'iflow', btnLabel: 'iFlow 登录' }
  ];
  const groups = {};
  accounts.forEach(c => {
    const p = c.provider || 'gemini';
    if (!groups[p]) groups[p] = [];
    groups[p].push(c);
  });

  let html = '';
  provDefs.forEach(pd => {
    const items = groups[pd.key] || [];
    html += `<div style="margin-bottom: 20px;">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
        <span class="model-badge ${pd.badge}">${pd.label}</span>
        <span style="font-size: 11px; color: var(--text-muted);">${items.length} 个凭证</span>
      </div>`;

    if (!items.length) {
      html += `<div style="background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">
        暂无凭证 &nbsp;
        <button class="btn btn-secondary btn-sm" onclick="startAuth('${pd.authFn}')">${pd.btnLabel}</button>
      </div>`;
    } else {
      html += '<div class="table-wrapper"><table class="data-table"><thead><tr><th>账户</th><th>项目 ID</th><th>状态</th><th>刷新令牌</th>' + (hasProxy ? '<th>代理</th>' : '') + '<th></th></tr></thead><tbody>';
      items.forEach(c => {
        const status = c.expires_at ? (c.expires_at > Date.now() ? 'valid' : 'expired') : 'permanent';
        const statusClass = status === 'valid' ? 'success' : status === 'expired' ? 'error' : 'warning';
        const statusText = status === 'valid' ? '有效' : status === 'expired' ? '过期' : '永久';
        const hasRefresh = c.has_refresh_token ? '有' : '无';
        const project = c.project_id ? `<code>${esc(c.project_id)}</code>` : '<span class="text-muted">无</span>';
        const proxy = hasProxy ? `<td>${c.proxy_url ? `<code>${esc(c.proxy_url)}</code>` : '-'}</td>` : '';

        html += `<tr>
          <td><code>${esc(c.account_id)}</code></td>
          <td>${project}</td>
          <td><span class="status-badge ${statusClass}">${statusText}</span></td>
          <td>${hasRefresh}</td>
          ${proxy}
          <td><button class="btn btn-icon btn-sm" onclick="deleteCredential('${esc(c.account_id)}','${esc(c.provider||'gemini')}')" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button></td>
        </tr>`;
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
  });

  list.innerHTML = html;
}

async function deleteCredential(id, provider) {
  if (!confirm('确定删除此凭证？')) return;
  let url = '/auth/accounts/' + encodeURIComponent(id);
  if (provider) url += '?provider=' + encodeURIComponent(provider);
  const r = await rpc(url, { method: 'DELETE' });
  if (r.ok) {
    toast('已删除', 'success');
    loadCredentials();
    checkAuth();
  } else {
    toast('删除失败', 'error');
  }
}

// ========== Chat ==========
function setProto(p) {
  currentProto = p;
  document.querySelectorAll('#page-chat .protocol-tab').forEach(t => t.classList.toggle('active', t.dataset.proto === p));
  clearChat();
}

function clearChat() {
  chatHistory = [];
  $('chatMessages').innerHTML = '<div class="chat-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/></svg><p>发送消息开始对话</p></div>';
}

function addMessage(role, content) {
  const box = $('chatMessages');
  const empty = box.querySelector('.chat-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = `chat-message ${role}`;
  div.textContent = content;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;

  const model = $('chatModel').value;
  const temp = parseFloat($('chatTemp').value);
  const system = $('chatSystem').value.trim();

  input.value = '';
  addMessage('user', text);
  chatHistory.push({ role: 'user', content: text });

  const box = $('chatMessages');
  const loading = document.createElement('div');
  loading.className = 'chat-message assistant';
  loading.innerHTML = '<div class="spinner"></div>';
  box.appendChild(loading);
  box.scrollTop = box.scrollHeight;

  try {
    let r;

    if (currentProto === 'anthropic') {
      const msgs = chatHistory.map(m => ({ role: m.role, content: m.content }));
      const body = { model, messages: msgs, max_tokens: 4096, temperature: temp };
      if (system) body.system = system;
      r = await rpc('/v1/messages', { method: 'POST', body: JSON.stringify(body) });
      loading.remove();
      if (r.ok && r.data?.content?.[0]) {
        const reply = r.data.content[0].text || '无响应';
        addMessage('assistant', reply);
        chatHistory.push({ role: 'assistant', content: reply });
      } else {
        addMessage('assistant', '错误: ' + (r.data?.error?.message || r.error || '未知错误'));
      }
    } else if (currentProto === 'gemini') {
      const contents = [];
      chatHistory.forEach(m => contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const geminiBody = { contents, generationConfig: { temperature: temp } };
      if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };
      r = await rpc('/v1beta/models/' + model + ':generateContent', {
        method: 'POST',
        body: JSON.stringify(geminiBody)
      });
      loading.remove();
      if (r.ok && r.data?.candidates?.[0]) {
        const reply = r.data.candidates[0].content?.parts?.[0]?.text || '无响应';
        addMessage('assistant', reply);
        chatHistory.push({ role: 'assistant', content: reply });
      } else {
        addMessage('assistant', '错误: ' + (r.data?.error?.message || r.error || '未知错误'));
      }
    } else {
      // OpenAI format
      const msgs = [];
      if (system) msgs.push({ role: 'system', content: system });
      msgs.push(...chatHistory.map(m => ({ role: m.role, content: m.content })));
      r = await rpc('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages: msgs, temperature: temp }) });
      loading.remove();
      if (r.ok && r.data?.choices?.[0]?.message) {
        const reply = r.data.choices[0].message.content || '无响应';
        addMessage('assistant', reply);
        chatHistory.push({ role: 'assistant', content: reply });
      } else {
        addMessage('assistant', '错误: ' + (r.data?.error?.message || r.error || '未知错误'));
      }
    }
  } catch (e) {
    loading.remove();
    addMessage('assistant', '错误: ' + e.message);
  }
}

// ========== Management ==========
async function reloadConfig() {
  const r = await rpc('/v0/management/reload', { method: 'POST' });
  if (r.ok) {
    toast('配置已重载', 'success');
    loadAll();
  } else {
    toast('重载失败', 'error');
  }
}

async function showConfig() {
  const r = await rpc('/v0/management/config');
  if (!r.ok) {
    toast('获取配置失败', 'error');
    return;
  }
  $('configDisplay').classList.remove('hidden');
  $('configContent').textContent = JSON.stringify(r.data, null, 2);
}

async function loadAuthSettings() {
  const r = await rpc('/auth/settings');
  if (r.ok) {
    $('settingApiKey').value = r.data.apiKey || '';
    $('settingLoginSecret').value = r.data.loginSecret || '';
  }
}

async function saveAuthSettings(field) {
  const body = {};
  if (field === 'apiKey') {
    body.apiKey = $('settingApiKey').value;
  } else {
    body.loginSecret = $('settingLoginSecret').value;
  }
  const r = await rpc('/auth/settings', { method: 'POST', body: JSON.stringify(body) });
  if (r.ok) {
    toast('已保存', 'success');
    if (field === 'loginSecret') {
      PW = body.loginSecret;
      localStorage.setItem('proxy_login_secret', PW);
    }
  } else {
    toast('保存失败: ' + (r.data?.error || ''), 'error');
  }
}

function copyApiKey() {
  const key = $('settingApiKey').value;
  if (!key) return;
  navigator.clipboard.writeText(key).then(() => toast('已复制', 'success'));
}

// ========== Log Stream ==========
let logEs = null;
let logEntries = [];
const LOG_MAX = 500;

function startLogStream() {
  if (logEs) return; // already connected
  logEs = new EventSource(API + '/v0/management/logs?token=' + encodeURIComponent(PW));
  logEs.onopen = () => {
    appendLogLine({ ts: Date.now(), level: 'info', msg: '日志流已连接' });
  };
  logEs.onmessage = (e) => {
    try {
      const entry = JSON.parse(e.data);
      logEntries.push(entry);
      if (logEntries.length > LOG_MAX) logEntries.shift();
      appendLogLine(entry);
    } catch {}
  };
  logEs.onerror = () => {
    appendLogLine({ ts: Date.now(), level: 'warn', msg: '日志流断开，正在重连...' });
    logEs.close();
    logEs = null;
    // Reconnect after 3s
    setTimeout(() => {
      if ($('page-logs')?.classList.contains('active')) startLogStream();
    }, 3000);
  };
}

let logFirstLine = true;
function appendLogLine(entry) {
  const filter = $('logFilter')?.value || 'all';
  if (filter !== 'all' && entry.level !== filter) return;

  // Clear placeholder on first line
  if (logFirstLine) {
    $('logContent').innerHTML = '';
    logFirstLine = false;
  }

  const el = document.createElement('div');
  el.className = 'log-line';
  el.dataset.level = entry.level;

  const t = new Date(entry.ts);
  const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  const ms = String(t.getMilliseconds()).padStart(3, '0');

  const meta = entry.meta ? ` <span class="log-meta">${JSON.stringify(entry.meta)}</span>` : '';
  el.innerHTML = `<span class="log-time">${ts}.${ms}</span> <span class="log-tag ${entry.level}">${entry.level.toUpperCase()}</span><span class="log-msg">${escHtml(entry.msg)}</span>${meta}`;

  $('logContent').appendChild(el);

  // Trim DOM
  const container = $('logContent');
  while (container.children.length > LOG_MAX) container.removeChild(container.firstChild);

  // Auto scroll
  if ($('logAutoScroll')?.checked) {
    $('logContainer').scrollTop = $('logContainer').scrollHeight;
  }
}

function filterLogs() {
  const filter = $('logFilter').value;
  $('logContent').innerHTML = '';
  for (const entry of logEntries) {
    if (filter === 'all' || entry.level === filter) {
      appendLogLine(entry);
    }
  }
}

function clearLogs() {
  logEntries = [];
  $('logContent').innerHTML = '';
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toggleAddMenu(show) {
  const dropdown = $('addDropdown');
  if (show === undefined) show = !dropdown.classList.contains('open');
  dropdown.classList.toggle('open', show);
}

// ========== Provider Toggle & Model Exclude ==========
async function toggleProvider(provider, enabled) {
  const r = await rpc('/v0/management/providers/' + provider, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  if (r.ok) {
    toast(`${provider} 已${enabled ? '启用' : '禁用'}`, 'success');
    loadAll();
  } else {
    toast('操作失败: ' + (r.data?.error || ''), 'error');
    // Rollback toggle
    $('toggle' + provider.charAt(0).toUpperCase() + provider.slice(1)).checked = !enabled;
  }
}

async function toggleModelExclude(provider, model, action) {
  const r = await rpc('/v0/management/providers/' + provider + '/excluded-models', {
    method: 'PATCH',
    body: JSON.stringify({ model, action }),
  });
  if (r.ok) {
    toast(action === 'add' ? `${model} 已隐藏` : `${model} 已显示`, 'success');
    loadModels();
  } else {
    toast('操作失败: ' + (r.data?.error || ''), 'error');
  }
}

function toggleShowExcluded() {
  showExcluded = $('showExcluded').checked;
  loadModels();
}

// ========== Utils ==========
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
