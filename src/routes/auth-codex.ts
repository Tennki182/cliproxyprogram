import { FastifyInstance } from 'fastify';
import { randomBytes, createHash } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { pfetch } from '../services/http.js';
import { saveCredential } from '../storage/credentials.js';
import { getCodexOAuthConfig } from '../config.js';
import { logInfo, logError } from '../services/log-stream.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

const PAGE_HEAD = `<meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,sans-serif;background:#07070a;color:#f2f2f4;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .box{max-width:480px;padding:36px;text-align:center}
  h2{font-size:20px;margin-bottom:12px}
  p{color:#9898a6;line-height:1.7;font-size:14px;word-break:break-all;margin-bottom:8px}
  .ok{color:#34d399}.err{color:#fb7185}
  a{color:#7c5cf8;text-decoration:none;font-size:13px}a:hover{text-decoration:underline}
  .tag{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;margin-bottom:12px}
  .tag-ok{background:rgba(52,211,153,.12);color:#34d399}
  .tag-err{background:rgba(251,113,133,.12);color:#fb7185}
  code{background:#222;padding:2px 6px;border-radius:4px;font-size:12px}
  .manual-box{margin-top:20px;text-align:left}
  textarea{width:100%;background:#111;border:1px solid #333;color:#f2f2f4;border-radius:6px;padding:10px;font-size:13px;font-family:monospace;resize:vertical;min-height:60px}
  button{margin-top:10px;background:#7c5cf8;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px}
  button:hover{background:#6b4ce0}
</style>`;

/** HTML snippet: notify opener window then close/redirect */
function makeCallbackScript(targetOrigin: string): string {
  return `<script>
  if(window.opener){window.opener.postMessage({type:'auth-complete'},'${targetOrigin}');setTimeout(()=>window.close(),2000)}
  else{setTimeout(()=>{window.location.href='/'},2000)}
</script>`;
}

const OAUTH_CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/auth/callback`;

const PKCE_EXPIRY_MS = 10 * 60 * 1000;
const pkceStore = new Map<string, { verifier: string; expiresAt: number }>();

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function cleanExpiredStates(): void {
  const now = Date.now();
  for (const [state, data] of pkceStore) {
    if (data.expiresAt < now) pkceStore.delete(state);
  }
}

/**
 * Generate PKCE verifier, challenge, and state for Codex OAuth.
 * Stores the verifier in pkceStore keyed by state.
 */
export function generatePkce(): { challenge: string; state: string } {
  cleanExpiredStates();
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  const state = base64UrlEncode(randomBytes(16));
  pkceStore.set(state, { verifier, expiresAt: Date.now() + PKCE_EXPIRY_MS });
  return { challenge, state };
}

/**
 * Shared token exchange logic: validate PKCE state, exchange code for tokens, save credential.
 * Returns { accountId } on success.
 */
export async function exchangeCodexCode(code: string, state: string): Promise<{ accountId: string }> {
  const pkce = pkceStore.get(state);
  if (!pkce) {
    throw new Error('无效的 state，请重新登录');
  }
  if (Date.now() > pkce.expiresAt) {
    pkceStore.delete(state);
    throw new Error('State 已过期，请重新登录');
  }
  pkceStore.delete(state);

  const codexConfig = getCodexOAuthConfig();
  const tokenResponse = await pfetch(codexConfig.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: codexConfig.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
    }),
  });

  const tokens = await tokenResponse.json() as any;
  if (!tokens.access_token) {
    const errDetail = tokens.error_description
      || (typeof tokens.error === 'string' ? tokens.error : JSON.stringify(tokens.error))
      || 'Token exchange failed';
    throw new Error(errDetail);
  }

  // Extract account info from id_token
  let accountId = `codex_${Date.now()}`;
  if (tokens.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
      const authClaim = payload['https://api.openai.com/auth'] || {};
      accountId = payload.email || authClaim.chatgpt_user_id || accountId;
    } catch { /* ignore */ }
  }

  const credential = {
    account_id: accountId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || undefined,
    expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    scope: tokens.scope || 'openid email profile offline_access',
    provider: 'codex',
  };
  saveCredential(credential);
  logInfo(`Codex 认证成功: ${accountId}`);

  return { accountId };
}

/**
 * Start a temporary HTTP server on port 1455 to receive the OAuth callback.
 * OpenAI's client_id ONLY accepts http://localhost:1455/auth/callback.
 */
function startCallbackServer(adminOrigin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://localhost:${OAUTH_CALLBACK_PORT}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404); res.end('Not Found'); return;
      }

      // Always close the temp server after handling
      setTimeout(() => { try { server.close(); } catch {} }, 1000);

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        logError(`Codex OAuth 被拒绝: ${error}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><head>${PAGE_HEAD}</head><body><div class="box">
          <span class="tag tag-err">Codex 授权失败</span>
          <h2 class="err">OpenAI 拒绝了授权</h2>
          <p>${escapeHtml(String(error))}</p>
          <a href="${adminOrigin}/">返回管理面板</a>
        </div></body></html>`);
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('缺少授权码或 state'); return;
      }

      try {
        const { accountId } = await exchangeCodexCode(code, state);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><head>${PAGE_HEAD}</head><body><div class="box">
          <span class="tag tag-ok">Codex 授权成功</span>
          <h2 class="ok">OpenAI Codex 认证完成</h2>
          <p>账户: ${escapeHtml(accountId)}</p>
          ${makeCallbackScript(adminOrigin)}
        </div></body></html>`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
        logError(`Codex token 交换失败: ${errMsg}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><head>${PAGE_HEAD}</head><body><div class="box">
          <span class="tag tag-err">Codex 授权失败</span>
          <h2 class="err">认证出错</h2>
          <p>${escapeHtml(errMsg)}</p>
          <a href="${adminOrigin}/">返回管理面板</a>
        </div></body></html>`);
      }
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(); // another login already in progress
      } else {
        reject(err);
      }
    });

    server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      logInfo(`Codex 回调服务器已启动 :${OAUTH_CALLBACK_PORT}`);
      resolve();
    });

    // Auto-close after PKCE expiry
    setTimeout(() => { try { server.close(); } catch {} }, PKCE_EXPIRY_MS);
  });
}

export async function codexAuthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /auth/codex/login — Redirect to OpenAI OAuth with PKCE
   * On VPS (non-localhost), show a manual auth page instead of starting callback server
   */
  fastify.get('/auth/codex/login', async (request, reply) => {
    // Remember the admin panel origin for redirect-back links
    const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
    const host = (request.headers['x-forwarded-host'] as string) || request.headers.host || 'localhost:8488';
    const adminOrigin = `${proto}://${host}`;

    const hostname = host.split(':')[0];
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

    // Generate PKCE
    const { challenge, state } = generatePkce();

    const codexConfig = getCodexOAuthConfig();
    const params = new URLSearchParams({
      client_id: codexConfig.clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: 'openid email profile offline_access',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'login',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
    });

    const authUrl = `${codexConfig.authEndpoint}?${params.toString()}`;

    if (isLocal) {
      // Local access: start temporary callback server and redirect
      await startCallbackServer(adminOrigin);
      return reply.redirect(authUrl);
    }

    // Remote/VPS: show manual auth page (no callback server since it can't receive the redirect)
    return reply.type('text/html; charset=utf-8').send(
      `<html><head>${PAGE_HEAD}</head><body><div class="box">
        <span class="tag tag-ok">远程认证</span>
        <h2>Codex (OpenAI) 远程授权</h2>
        <p>检测到您通过远程方式访问，请按以下步骤完成认证：</p>
        <div class="manual-box" style="padding:14px;background:#1a1a2e;border:1px solid #333;border-radius:8px;font-size:13px;color:#ccc;line-height:1.7">
          <strong>步骤 1</strong>：<a href="${escapeHtml(authUrl)}" target="_blank" style="color:#7c5cf8">点击此处打开 OpenAI 授权页面</a><br>
          <strong>步骤 2</strong>：完成授权后，浏览器会跳转到 <code>http://localhost:1455/...</code> 并显示错误（这是正常的）<br>
          <strong>步骤 3</strong>：复制浏览器地址栏中的完整 URL，粘贴到下方输入框
        </div>
        <form onsubmit="return submitCallback()" style="margin-top:16px;text-align:left;">
          <input id="callbackUrl" type="text" placeholder="粘贴回调 URL (http://localhost:1455/...?code=...)" style="width:100%;background:#111;border:1px solid #333;color:#f2f2f4;border-radius:6px;padding:10px;font-size:13px;font-family:monospace;">
          <button type="submit" style="margin-top:10px;background:#7c5cf8;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:13px;">提交</button>
        </form>
        <p id="resultMsg" style="margin-top:12px;display:none;"></p>
        <br><a href="/">返回管理面板</a>
        <script>
        async function submitCallback(){
          var url=document.getElementById('callbackUrl').value.trim();
          if(!url){alert('请粘贴回调 URL');return false;}
          var msg=document.getElementById('resultMsg');
          msg.style.display='none';
          try{
            var r=await fetch('${adminOrigin}/auth/remote/exchange',{
              method:'POST',
              headers:{'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.getItem('proxy_login_secret')||'')},
              body:JSON.stringify({provider:'codex',callbackUrl:url})
            });
            var d=await r.json();
            if(d.success){
              msg.className='ok';msg.textContent='认证成功: '+d.accountId;msg.style.display='block';
              setTimeout(function(){location.href='/';},1500);
            }else{
              msg.className='err';msg.textContent='失败: '+(d.error||'未知错误');msg.style.display='block';
            }
          }catch(e){
            msg.className='err';msg.textContent='请求失败: '+e.message;msg.style.display='block';
          }
          return false;
        }
        </script>
      </div></body></html>`
    );
  });

  /**
   * GET /auth/codex/callback — 手动回调入口
   * 当 1455 端口临时服务器已关闭时，用户可将回调 URL 的
   * localhost:1455/auth/callback 改为 localhost:8488/auth/codex/callback 来完成授权。
   */
  fastify.get('/auth/codex/callback', async (request, reply) => {
    const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
    const host = (request.headers['x-forwarded-host'] as string) || request.headers.host || 'localhost:8488';
    const adminOrigin = `${proto}://${host}`;

    const query = request.query as Record<string, string>;
    const code = query.code;
    const state = query.state;
    const error = query.error;

    if (error) {
      logError(`Codex OAuth 被拒绝: ${error}`);
      reply.type('text/html; charset=utf-8');
      return `<html><head>${PAGE_HEAD}</head><body><div class="box">
        <span class="tag tag-err">Codex 授权失败</span>
        <h2 class="err">OpenAI 拒绝了授权</h2>
        <p>${escapeHtml(String(error))}</p>
        <a href="/">返回管理面板</a>
      </div></body></html>`;
    }

    if (!code || !state) {
      reply.type('text/html; charset=utf-8');
      return `<html><head>${PAGE_HEAD}</head><body><div class="box">
        <span class="tag tag-err">参数缺失</span>
        <h2 class="err">缺少授权码或 state</h2>
        <p>请粘贴完整的回调 URL（包含 code 和 state 参数）</p>
        <a href="/">返回管理面板</a>
      </div></body></html>`;
    }

    try {
      const { accountId } = await exchangeCodexCode(code, state);
      reply.type('text/html; charset=utf-8');
      return `<html><head>${PAGE_HEAD}</head><body><div class="box">
        <span class="tag tag-ok">Codex 授权成功</span>
        <h2 class="ok">OpenAI Codex 认证完成</h2>
        <p>账户: ${escapeHtml(accountId)}</p>
        ${makeCallbackScript(adminOrigin)}
      </div></body></html>`;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
      logError(`Codex token 交换失败（手动回调）: ${errMsg}`);
      reply.type('text/html; charset=utf-8');
      return `<html><head>${PAGE_HEAD}</head><body><div class="box">
        <span class="tag tag-err">Codex 授权失败</span>
        <h2 class="err">认证出错</h2>
        <p>${escapeHtml(errMsg)}</p>
        <a href="/">返回管理面板</a>
      </div></body></html>`;
    }
  });
}
