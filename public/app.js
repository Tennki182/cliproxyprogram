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
  if (page === 'stats') { loadUsageStats(); loadRequestHistory(); }
  if (page === 'providers') loadProviders();
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

  if (!/^https?:\/\/localhost(:\d+)?\//.test(callbackUrl)) {
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
  renderModelFilters();
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
  // Built-in providers with fixed order
  const builtinOrder = ['gemini', 'codex', 'iflow'];
  const builtinLabels = { gemini: 'Gemini', codex: 'Codex', iflow: 'iFlow' };

  // Render built-in providers first
  builtinOrder.forEach(p => {
    if (!groups[p]) return;
    const activeCount = groups[p].filter(m => !m.x_excluded).length;
    const totalCount = groups[p].length;
    const countLabel = showExcluded && activeCount !== totalCount ? `${activeCount}/${totalCount}` : `${totalCount}`;
    html += `<div style="margin-bottom: 20px;">
      <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">${builtinLabels[p]} · ${countLabel} 个模型</div>`;
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
          <span class="model-badge ${p}">${builtinLabels[p]}</span>
          <button class="model-hide-btn" onclick="event.stopPropagation();toggleModelExclude('${esc(provider)}','${esc(modelName)}','${actionType}')">${actionLabel}</button>
        </span>
      </div>`;
    });
    html += '</div>';
  });

  // Render OpenAI-compatible providers
  Object.keys(groups).forEach(p => {
    if (builtinOrder.includes(p)) return; // Skip built-in providers
    const activeCount = groups[p].filter(m => !m.x_excluded).length;
    const totalCount = groups[p].length;
    const countLabel = showExcluded && activeCount !== totalCount ? `${activeCount}/${totalCount}` : `${totalCount}`;
    const displayName = p.charAt(0).toUpperCase() + p.slice(1);
    html += `<div style="margin-bottom: 20px;">
      <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">${displayName} · ${countLabel} 个模型</div>`;
    groups[p].forEach(m => {
      const isExcluded = !!m.x_excluded;
      const excludedClass = isExcluded ? ' excluded' : '';
      const modelName = m.id.includes('/') ? m.id.split('/').slice(1).join('/') : m.id;
      const provider = m.x_provider || 'gemini';
      const actionLabel = isExcluded ? '显示' : '隐藏';
      const actionType = isExcluded ? 'remove' : 'add';
      const excludedTag = isExcluded ? ' <span style="font-size:10px;color:var(--accent-warning);">(已隐藏)</span>' : '';
      html += `<div class="model-item${excludedClass}" onclick="selectModel('${esc(m.id)}')">
        <span class="model-name">${esc(m.id)}${excludedTag}</span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="model-badge openai-compat">${displayName}</span>
          <button class="model-hide-btn" onclick="event.stopPropagation();toggleModelExclude('${esc(provider)}','${esc(modelName)}','${actionType}')">${actionLabel}</button>
        </span>
      </div>`;
    });
    html += '</div>';
  });

  list.innerHTML = html;
}

/**
 * Dynamically render model filter tabs based on available providers.
 */
function renderModelFilters() {
  const filterContainer = $('modelFilter');
  if (!filterContainer) return;

  // Get unique providers from models
  const providers = new Set();
  allModels.forEach(m => {
    providers.add(m.x_provider || 'gemini');
  });

  // Build filter tabs
  let html = '<div class="protocol-tab active" data-pf="all" onclick="filterModels(\'all\')">全部</div>';
  
  // Built-in providers
  const builtinOrder = ['gemini', 'codex', 'iflow'];
  const builtinLabels = { gemini: 'Gemini', codex: 'Codex', iflow: 'iFlow' };
  
  builtinOrder.forEach(p => {
    if (providers.has(p)) {
      html += `<div class="protocol-tab" data-pf="${p}" onclick="filterModels('${p}')">${builtinLabels[p]}</div>`;
    }
  });

  // OpenAI-compatible providers
  providers.forEach(p => {
    if (!builtinOrder.includes(p)) {
      const displayName = p.charAt(0).toUpperCase() + p.slice(1);
      html += `<div class="protocol-tab" data-pf="${p}" onclick="filterModels('${p}')">${displayName}</div>`;
    }
  });

  // Add "show excluded" checkbox at the end
  html += `<label style="margin-left:auto;font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:6px;cursor:pointer;">
    <input type="checkbox" id="showExcluded" onchange="toggleShowExcluded()" style="accent-color:var(--accent-primary);">
    显示隐藏模型
  </label>`;

  filterContainer.innerHTML = html;
  
  // Restore active state
  document.querySelectorAll('#modelFilter .protocol-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.pf === modelFilter);
  });
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


// ========== Usage Statistics ==========
let usageDataCache = null;
let requestHistoryCache = null;

async function loadUsageStats() {
  try {
    // Load all usage data in parallel
    const [usage, credentials, daily, hourly] = await Promise.all([
      rpc('/v0/management/usage'),
      rpc('/v0/management/usage/credentials'),
      rpc('/v0/management/usage/daily?days=7'),
      rpc('/v0/management/usage/hourly')
    ]);
    
    usageDataCache = { usage, credentials, daily, hourly };
    
    // Update summary stats - rpc returns { ok, data, status }, data contains the actual response
    const usageData = usage.data || {};
    if (usageData.global) {
      $('statsTotalRequests').textContent = formatNumber(usageData.global.totalRequests);
      $('statsSuccessRequests').textContent = formatNumber(usageData.global.successCount);
      $('statsFailedRequests').textContent = formatNumber(usageData.global.failureCount);
      $('statsTotalTokens').textContent = formatNumber(usageData.global.totalTokens);
    }
    
    // Render credential stats
    const credData = credentials.data || {};
    renderCredentialStats(credData.credentials || []);
    
    // Render daily chart
    const dailyData = daily.data || {};
    renderDailyChart(dailyData.daily || []);
    
    // Render hourly chart
    const hourlyData = hourly.data || {};
    renderHourlyChart(hourlyData.hourly || []);
    
  } catch (e) {
    console.error('Failed to load usage stats:', e);
    toast('加载统计数据失败', 'error');
  }
}

function renderCredentialStats(credentials) {
  const container = $('credentialStatsList');
  if (!credentials || credentials.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无凭证使用数据</p></div>';
    return;
  }
  
  // Calculate totals for percentages
  const totalRequests = credentials.reduce((sum, c) => sum + (c.totalRequests || c.requests || 0), 0);
  const totalTokens = credentials.reduce((sum, c) => sum + (c.totalTokens || (c.tokens && c.tokens.total) || 0), 0);
  
  let html = '<table class="stats-table"><thead><tr>';
  html += '<th>凭证</th><th>提供商</th><th>请求数</th><th>模型数</th>';
  html += '<th>Token 总计</th><th>占比</th>';
  html += '</tr></thead><tbody>';
  
  credentials.forEach(c => {
    const providerClass = `provider-${c.provider || 'unknown'}`;
    const requests = c.totalRequests || c.requests || 0;
    const tokens = c.totalTokens || (c.tokens && c.tokens.total) || 0;
    const requestPercent = totalRequests > 0 ? Math.round((requests / totalRequests) * 100) : 0;
    const modelCount = c.models ? c.models.length : 0;
    
    html += '<tr>';
    html += `<td><code>${esc((c.accountId || 'unknown').substring(0, 20))}</code></td>`;
    html += `<td><span class="provider-badge ${providerClass}">${esc(c.provider || 'unknown')}</span></td>`;
    html += `<td class="number text-right">${formatNumber(requests)}</td>`;
    html += `<td class="number text-right">${modelCount}</td>`;
    html += `<td class="number text-right"><strong>${formatNumber(tokens)}</strong></td>`;
    html += `<td><div class="bar-item" style="width:60px"><div class="bar" style="height:8px;width:${requestPercent}%;background:var(--accent-primary)"></div><div class="bar-label">${requestPercent}%</div></div></td>`;
    html += '</tr>';
  });
  
  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderDailyChart(dailyData) {
  const container = $('dailyStatsChart');
  if (!dailyData || dailyData.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无日统计数据</p></div>';
    return;
  }
  
  // Backend returns {date, totalRequests, totalTokens, byProvider}
  const maxRequests = Math.max(...dailyData.map(d => d.totalRequests || 0), 1);
  
  let html = '<div class="bar-chart">';
  
  dailyData.forEach(day => {
    const requests = day.totalRequests || 0;
    const height = Math.max((requests / maxRequests) * 100, 4);
    const date = new Date(day.date);
    const label = `${date.getMonth() + 1}/${date.getDate()}`;
    
    html += '<div class="bar-item">';
    html += `<div class="bar" style="height:${height}%" data-value="${formatNumber(requests)}"></div>`;
    html += `<div class="bar-value">${formatNumber(requests)}</div>`;
    html += `<div class="bar-label">${label}</div>`;
    html += '</div>';
  });
  
  html += '</div>';
  
  // Add provider breakdown
  html += '<div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-subtle);">';
  html += '<div style="display: flex; gap: 24px; flex-wrap: wrap; font-size: 12px;">';
  
  // Aggregate by provider (backend uses byProvider)
  const providerStats = {};
  dailyData.forEach(day => {
    Object.entries(day.byProvider || {}).forEach(([provider, stats]) => {
      if (!providerStats[provider]) providerStats[provider] = { requests: 0, tokens: 0 };
      providerStats[provider].requests += stats.requests || 0;
      providerStats[provider].tokens += stats.tokens || 0;
    });
  });
  
  Object.entries(providerStats).forEach(([provider, stats]) => {
    const providerClass = `provider-${provider}`;
    html += `<div style="display: flex; align-items: center; gap: 8px;">`;
    html += `<span class="provider-badge ${providerClass}">${esc(provider)}</span>`;
    html += `<span style="color: var(--text-muted);">${formatNumber(stats.requests)} 请求</span>`;
    html += `<span style="color: var(--text-muted);">·</span>`;
    html += `<span style="color: var(--text-muted);">${formatNumber(stats.tokens)} tokens</span>`;
    html += '</div>';
  });
  
  html += '</div></div>';
  
  container.innerHTML = html;
}

function renderHourlyChart(hourlyData) {
  const container = $('hourlyStatsChart');
  if (!hourlyData || hourlyData.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无小时统计数据</p></div>';
    return;
  }
  
  // Find max for scaling
  const maxRequests = Math.max(...hourlyData.map(h => h.requests), 1);
  
  let html = '<div class="bar-chart">';
  
  hourlyData.forEach(hour => {
    const height = Math.max((hour.requests / maxRequests) * 100, 4);
    const label = `${String(hour.hour).padStart(2, '0')}`;
    
    html += '<div class="bar-item">';
    html += `<div class="bar" style="height:${height}%" data-value="${formatNumber(hour.requests)}"></div>`;
    html += `<div class="bar-value">${formatNumber(hour.requests)}</div>`;
    html += `<div class="bar-label">${label}:00</div>`;
    html += '</div>';
  });
  
  html += '</div>';
  
  // Summary
  const totalRequests = hourlyData.reduce((sum, h) => sum + h.requests, 0);
  const totalTokens = hourlyData.reduce((sum, h) => sum + h.tokens, 0);
  
  html += '<div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-subtle);">';
  html += '<div class="stats-summary">';
  html += `<div class="stats-summary-item"><div class="stats-summary-label">今日请求</div><div class="stats-summary-value">${formatNumber(totalRequests)}</div></div>`;
  html += `<div class="stats-summary-item"><div class="stats-summary-label">今日 Token</div><div class="stats-summary-value">${formatNumber(totalTokens)}</div></div>`;
  html += `<div class="stats-summary-item"><div class="stats-summary-label">平均每时</div><div class="stats-summary-value">${formatNumber(Math.round(totalRequests / 24))}</div></div>`;
  html += '</div></div>';
  
  container.innerHTML = html;
}

async function loadRequestHistory() {
  const limit = parseInt($('historyLimit').value) || 50;
  try {
    const result = await rpc(`/v0/management/history?limit=${limit}`);
    const resultData = result.data || {};
    requestHistoryCache = resultData.history || [];
    renderRequestHistory(requestHistoryCache);
  } catch (e) {
    console.error('Failed to load request history:', e);
    $('requestHistoryList').innerHTML = '<div class="empty-state"><p>加载请求历史失败</p></div>';
  }
}

function renderRequestHistory(history) {
  const container = $('requestHistoryList');
  if (!history || history.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无请求记录</p></div>';
    return;
  }
  
  let html = '<table class="history-table"><thead><tr>';
  html += '<th>时间</th><th>凭证</th><th>提供商</th><th>模型</th><th>Token 输入</th><th>Token 输出</th><th>状态</th>';
  html += '</tr></thead><tbody>';
  
  history.forEach(req => {
    const time = new Date(req.timestamp);
    const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;
    const providerClass = `provider-${req.provider || 'unknown'}`;
    const statusIcon = req.success ? '<span class="success-badge">✓</span>' : '<span class="error-badge">✗</span>';
    // Backend returns inputTokens/outputTokens, not tokens.input/tokens.output
    const inputTokens = req.inputTokens !== undefined ? req.inputTokens : (req.tokens && req.tokens.input) || 0;
    const outputTokens = req.outputTokens !== undefined ? req.outputTokens : (req.tokens && req.tokens.output) || 0;
    
    html += '<tr>';
    html += `<td class="time">${timeStr}</td>`;
    html += `<td><code>${esc((req.accountId || 'unknown').substring(0, 16))}</code></td>`;
    html += `<td><span class="provider-badge ${providerClass}">${esc(req.provider || 'unknown')}</span></td>`;
    html += `<td class="model" title="${esc(req.model)}">${esc(req.model || 'unknown')}</td>`;
    html += `<td class="tokens">${formatNumber(inputTokens)}</td>`;
    html += `<td class="tokens">${formatNumber(outputTokens)}</td>`;
    html += `<td>${statusIcon}</td>`;
    html += '</tr>';
  });
  
  html += '</tbody></table>';
  container.innerHTML = html;
}

function formatNumber(num) {
  if (num === undefined || num === null) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}


// ========== OpenAI Compatible Provider Management ==========

let currentProviderName = null;
let currentProviderModels = [];

async function loadProviders() {
  try {
    const r = await rpc('/v0/management/openai-compat/providers');
    if (!r.ok) {
      $('providerList').innerHTML = `<div class="empty-state"><p>加载失败: ${r.data?.error || '未知错误'}</p></div>`;
      return;
    }
    
    const providers = r.data?.providers || [];
    renderProviders(providers);
  } catch (e) {
    $('providerList').innerHTML = `<div class="empty-state"><p>加载失败: ${e.message}</p></div>`;
  }
}

function renderProviders(providers) {
  const container = $('providerList');
  
  if (!providers || providers.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>
        </svg>
        <p>暂无 OpenAI 兼容 Provider</p>
        <p style="font-size:12px;color:var(--text-muted);margin-top:8px;">点击右上角按钮添加</p>
      </div>`;
    return;
  }

  let html = '<div style="display:grid;gap:16px;">';
  
  providers.forEach(p => {
    const statusClass = p.enabled ? 'success' : 'error';
    const statusText = p.enabled ? '启用' : '禁用';
    
    html += `
      <div class="provider-card-item" style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:20px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
          <div>
            <h4 style="font-size:16px;font-weight:600;margin-bottom:4px;">${esc(p.name)}</h4>
            <p style="font-size:12px;color:var(--text-muted);">${esc(p.baseUrl)}</p>
          </div>
          <span class="status-badge ${statusClass}">${statusText}</span>
        </div>
        
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          ${p.prefix ? `<span class="model-badge" style="font-size:11px;">前缀: ${esc(p.prefix)}</span>` : ''}
          <span class="model-badge openai-compat" style="font-size:11px;">API Key: ${esc(p.apiKey)}</span>
        </div>
        
        <div style="display:flex;gap:8px;">
          <button class="btn btn-secondary btn-sm" onclick="editProvider('${esc(p.name)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:4px;">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            编辑
          </button>
          <button class="btn btn-secondary btn-sm" onclick="manageProviderModels('${esc(p.name)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:4px;">
              <path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>
            </svg>
            模型
          </button>
          <button class="btn btn-icon btn-sm" onclick="deleteProvider('${esc(p.name)}')" title="删除" style="margin-left:auto;color:var(--accent-error);">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;">
              <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

// Provider Modal
function showAddProviderModal() {
  currentProviderName = null;
  $('providerModalTitle').textContent = '添加 Provider';
  $('providerName').value = '';
  $('providerName').disabled = false;
  $('providerBaseUrl').value = '';
  $('providerApiKey').value = '';
  $('providerPrefix').value = '';
  $('providerHeaders').value = '';
  $('providerError').style.display = 'none';
  $('providerSubmitBtn').textContent = '保存';
  $('providerModal').style.display = 'flex';
}

async function editProvider(name) {
  currentProviderName = name;
  try {
    const r = await rpc(`/v0/management/openai-compat/providers/${encodeURIComponent(name)}`);
    if (!r.ok) {
      toast('获取 Provider 信息失败', 'error');
      return;
    }
    
    const p = r.data?.provider;
    if (!p) {
      toast('Provider 不存在', 'error');
      return;
    }
    
    $('providerModalTitle').textContent = '编辑 Provider';
    $('providerName').value = p.name;
    $('providerName').disabled = true;
    $('providerBaseUrl').value = p.baseUrl;
    $('providerApiKey').value = ''; // Don't show masked key
    $('providerApiKey').placeholder = '留空表示不修改';
    $('providerPrefix').value = p.prefix || '';
    $('providerHeaders').value = JSON.stringify(p.headers || {}, null, 2);
    $('providerError').style.display = 'none';
    $('providerSubmitBtn').textContent = '更新';
    $('providerModal').style.display = 'flex';
  } catch (e) {
    toast('加载失败: ' + e.message, 'error');
  }
}

function closeProviderModal() {
  $('providerModal').style.display = 'none';
  currentProviderName = null;
}

async function submitProvider() {
  const name = $('providerName').value.trim();
  const baseUrl = $('providerBaseUrl').value.trim();
  const apiKey = $('providerApiKey').value.trim();
  const prefix = $('providerPrefix').value.trim();
  const headersStr = $('providerHeaders').value.trim();
  
  // Validation
  if (!currentProviderName) {
    if (!name) {
      $('providerError').textContent = '请输入名称';
      $('providerError').style.display = 'block';
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      $('providerError').textContent = '名称只能包含字母、数字、下划线和横线';
      $('providerError').style.display = 'block';
      return;
    }
  }
  
  if (!baseUrl) {
    $('providerError').textContent = '请输入 Base URL';
    $('providerError').style.display = 'block';
    return;
  }
  
  if (!currentProviderName && !apiKey) {
    $('providerError').textContent = '请输入 API Key';
    $('providerError').style.display = 'block';
    return;
  }
  
  let headers = {};
  if (headersStr) {
    try {
      headers = JSON.parse(headersStr);
    } catch (e) {
      $('providerError').textContent = 'Headers JSON 格式错误';
      $('providerError').style.display = 'block';
      return;
    }
  }
  
  $('providerError').style.display = 'none';
  $('providerSubmitBtn').disabled = true;
  $('providerSubmitBtn').textContent = currentProviderName ? '更新中...' : '保存中...';
  
  try {
    if (currentProviderName) {
      // Update existing
      const updates = { baseUrl, prefix: prefix || undefined, headers };
      if (apiKey) updates.apiKey = apiKey;
      
      const r = await rpc(`/v0/management/openai-compat/providers/${encodeURIComponent(currentProviderName)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
      
      if (r.ok) {
        toast('更新成功', 'success');
        closeProviderModal();
        loadProviders();
        loadModels(); // Refresh models list
      } else {
        $('providerError').textContent = r.data?.error || '更新失败';
        $('providerError').style.display = 'block';
      }
    } else {
      // Create new
      const r = await rpc('/v0/management/openai-compat/providers', {
        method: 'POST',
        body: JSON.stringify({ name, baseUrl, apiKey, prefix: prefix || undefined, headers }),
      });
      
      if (r.ok) {
        toast('创建成功', 'success');
        closeProviderModal();
        loadProviders();
        loadModels(); // Refresh models list
      } else {
        $('providerError').textContent = r.data?.error || '创建失败';
        $('providerError').style.display = 'block';
      }
    }
  } catch (e) {
    $('providerError').textContent = '请求失败: ' + e.message;
    $('providerError').style.display = 'block';
  } finally {
    $('providerSubmitBtn').disabled = false;
    $('providerSubmitBtn').textContent = currentProviderName ? '更新' : '保存';
  }
}

async function deleteProvider(name) {
  if (!confirm(`确定删除 Provider "${name}"？\n\n此操作将同时删除该 Provider 下的所有模型配置。`)) {
    return;
  }
  
  try {
    const r = await rpc(`/v0/management/openai-compat/providers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    
    if (r.ok) {
      toast('删除成功', 'success');
      loadProviders();
      loadModels(); // Refresh models list
    } else {
      toast('删除失败: ' + (r.data?.error || ''), 'error');
    }
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

// Provider Models Management
async function manageProviderModels(name) {
  currentProviderName = name;
  $('providerModelsTitle').textContent = `${name} - 模型管理`;
  $('providerModelsSubtitle').textContent = '管理该 Provider 支持的模型';
  $('providerModelsModal').style.display = 'flex';
  await loadProviderModels(name);
}

function closeProviderModelsModal() {
  $('providerModelsModal').style.display = 'none';
  currentProviderName = null;
  currentProviderModels = [];
}

async function loadProviderModels(name) {
  try {
    const r = await rpc(`/v0/management/openai-compat/providers/${encodeURIComponent(name)}`);
    if (!r.ok) {
      $('providerModelsList').innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px;">加载失败</p>`;
      return;
    }
    
    currentProviderModels = r.data?.models || [];
    renderProviderModels(currentProviderModels);
  } catch (e) {
    $('providerModelsList').innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px;">加载失败: ${e.message}</p>`;
  }
}

function renderProviderModels(models) {
  const container = $('providerModelsList');
  
  if (!models || models.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:40px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>
        </svg>
        <p>暂无模型</p>
        <p style="font-size:12px;color:var(--text-muted);margin-top:8px;">点击上方按钮添加或从上游同步</p>
      </div>`;
    return;
  }

  let html = '<div style="display:grid;gap:8px;max-height:400px;overflow-y:auto;">';
  
  models.forEach(m => {
    const statusClass = m.enabled ? 'success' : 'error';
    const statusText = m.enabled ? '启用' : '禁用';
    
    html += `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;background:rgba(255,255,255,0.02);border-radius:var(--radius-md);border:1px solid var(--border-subtle);">
        <div>
          <div style="font-weight:500;font-size:14px;">${esc(m.modelId)}</div>
          ${m.alias ? `<div style="font-size:12px;color:var(--text-muted);">别名: ${esc(m.alias)}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="status-badge ${statusClass}" style="font-size:11px;padding:2px 8px;">${statusText}</span>
          <button class="btn btn-icon btn-sm" onclick="toggleModelEnabled('${encodeURIComponent(m.modelId)}', ${!m.enabled})" title="${m.enabled ? '禁用' : '启用'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;">
              ${m.enabled 
                ? '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>' 
                : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'}
            </svg>
          </button>
          <button class="btn btn-icon btn-sm" onclick="deleteProviderModel('${encodeURIComponent(m.modelId)}')" title="删除" style="color:var(--accent-error);">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;">
              <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

async function toggleModelEnabled(modelId, enabled) {
  if (!currentProviderName) return;
  
  try {
    const r = await rpc(`/v0/management/openai-compat/providers/${encodeURIComponent(currentProviderName)}/models/${modelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    
    if (r.ok) {
      await loadProviderModels(currentProviderName);
      loadModels(); // Refresh main models list
    } else {
      toast('操作失败: ' + (r.data?.error || ''), 'error');
    }
  } catch (e) {
    toast('操作失败: ' + e.message, 'error');
  }
}

async function deleteProviderModel(modelId) {
  if (!currentProviderName) return;
  if (!confirm('确定删除此模型？')) return;
  
  try {
    const r = await rpc(`/v0/management/openai-compat/providers/${encodeURIComponent(currentProviderName)}/models/${modelId}`, {
      method: 'DELETE',
    });
    
    if (r.ok) {
      toast('删除成功', 'success');
      await loadProviderModels(currentProviderName);
      loadModels(); // Refresh main models list
    } else {
      toast('删除失败: ' + (r.data?.error || ''), 'error');
    }
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

async function syncProviderModels(e) {
  if (!currentProviderName) return;
  
  const btn = e.target.closest('button');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:4px;"></span>同步中...';
  
  try {
    const r = await rpc(`/v0/management/openai-compat/providers/${encodeURIComponent(currentProviderName)}/sync-models`, {
      method: 'POST',
    });
    
    if (r.ok) {
      toast(`成功同步 ${r.data?.synced || 0} 个模型`, 'success');
      await loadProviderModels(currentProviderName);
      loadModels(); // Refresh main models list
    } else {
      toast('同步失败: ' + (r.data?.error || ''), 'error');
    }
  } catch (e) {
    toast('同步失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// Add Model Modal
function showAddModelModal() {
  $('newModelId').value = '';
  $('newModelAlias').value = '';
  $('addModelError').style.display = 'none';
  $('addModelModal').style.display = 'flex';
}

function closeAddModelModal() {
  $('addModelModal').style.display = 'none';
}

async function submitAddModel() {
  if (!currentProviderName) return;
  
  const modelId = $('newModelId').value.trim();
  const alias = $('newModelAlias').value.trim();
  
  if (!modelId) {
    $('addModelError').textContent = '请输入模型 ID';
    $('addModelError').style.display = 'block';
    return;
  }
  
  $('addModelError').style.display = 'none';
  
  try {
    const r = await rpc(`/v0/management/openai-compat/providers/${encodeURIComponent(currentProviderName)}/models`, {
      method: 'POST',
      body: JSON.stringify({ modelId, alias: alias || undefined }),
    });
    
    if (r.ok) {
      toast('添加成功', 'success');
      closeAddModelModal();
      await loadProviderModels(currentProviderName);
      loadModels(); // Refresh main models list
    } else {
      $('addModelError').textContent = r.data?.error || '添加失败';
      $('addModelError').style.display = 'block';
    }
  } catch (e) {
    $('addModelError').textContent = '请求失败: ' + e.message;
    $('addModelError').style.display = 'block';
  }
}
