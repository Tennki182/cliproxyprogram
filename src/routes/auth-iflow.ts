import { FastifyInstance } from 'fastify';
import { randomBytes } from 'crypto';
import { pfetch } from '../services/http.js';
import { saveCredential } from '../storage/credentials.js';
import { getIFlowOAuthConfig, getConfig } from '../config.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

const PAGE_STYLE = `<meta charset="utf-8"><style>
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
</style>`;

const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const stateStore = new Map<string, { redirectUri: string; expiresAt: number }>();

function cleanExpiredStates(): void {
  const now = Date.now();
  for (const [state, data] of stateStore) {
    if (data.expiresAt < now) {
      stateStore.delete(state);
    }
  }
}

/** HTML snippet: notify opener window (new-tab auth flow) then close/redirect */
const CALLBACK_SCRIPT = (fallbackUrl: string) =>
  `<script>
    if(window.opener){window.opener.postMessage({type:'auth-complete'},location.origin);setTimeout(()=>window.close(),1500)}
    else{setTimeout(()=>{window.location.href='${fallbackUrl}'},1500)}
  </script>`;

function getBaseUrl(request: import('fastify').FastifyRequest): string {
  const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
  const host = (request.headers['x-forwarded-host'] as string) || request.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

/**
 * Generate an iFlow OAuth authorization URL with a localhost-based redirect URI.
 * Stores state in stateStore for later validation.
 */
export function generateIFlowAuthUrl(redirectBase: string): { authUrl: string } {
  cleanExpiredStates();
  const redirectUri = `${redirectBase}/auth/iflow/callback`;
  const iflowConfig = getIFlowOAuthConfig();
  const state = randomBytes(16).toString('hex');
  stateStore.set(state, { redirectUri, expiresAt: Date.now() + STATE_EXPIRY_MS });

  const params = new URLSearchParams({
    loginMethod: 'phone',
    type: 'phone',
    redirect: redirectUri,
    state,
    client_id: iflowConfig.clientId,
  });

  return { authUrl: `${iflowConfig.authEndpoint}?${params.toString()}` };
}

/**
 * Exchange an iFlow OAuth code for tokens and save the credential.
 * Validates state from stateStore. Returns { email } on success.
 */
export async function exchangeIFlowCode(code: string, state: string): Promise<{ email: string }> {
  const stateData = stateStore.get(state);
  if (!stateData) {
    throw new Error('无效的 state，请重新登录');
  }
  if (Date.now() > stateData.expiresAt) {
    stateStore.delete(state);
    throw new Error('State 已过期，请重新登录');
  }
  const redirectUri = stateData.redirectUri;
  stateStore.delete(state);

  const iflowConfig = getIFlowOAuthConfig();
  const basicAuth = Buffer.from(`${iflowConfig.clientId}:${iflowConfig.clientSecret}`).toString('base64');

  const tokenResponse = await pfetch(iflowConfig.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: iflowConfig.clientId,
      client_secret: iflowConfig.clientSecret,
    }),
  }, { proxyUrl: undefined });

  const tokens = await tokenResponse.json() as any;

  if (!tokens.access_token) {
    throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');
  }

  // Fetch user info + API key
  const userInfoResponse = await pfetch(
    `${iflowConfig.userinfoEndpoint}?accessToken=${tokens.access_token}`,
    { headers: { 'Accept': 'application/json' } },
    { proxyUrl: undefined }
  );

  const userInfo = await userInfoResponse.json() as any;

  if (!userInfo.success || !userInfo.data?.apiKey) {
    throw new Error('无法获取 iFlow API Key');
  }

  const apiKey = userInfo.data.apiKey;
  const email = userInfo.data.email || userInfo.data.phone || `iflow_${Date.now()}`;

  // Store the API key as access_token (iFlow uses API key for actual requests)
  const credential = {
    account_id: email,
    access_token: apiKey,
    refresh_token: tokens.refresh_token || undefined,
    expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    scope: tokens.scope || '',
    provider: 'iflow',
  };

  saveCredential(credential);
  return { email };
}

export async function iflowAuthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /auth/iflow/login — Redirect to iFlow OAuth
   * On VPS (non-localhost), show a manual auth page with localhost redirect_uri
   */
  fastify.get('/auth/iflow/login', async (request, reply) => {
    const baseUrl = getBaseUrl(request);
    const hostname = (request.headers.host || '').split(':')[0];
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

    if (isLocal) {
      const { authUrl } = generateIFlowAuthUrl(baseUrl);
      return reply.redirect(authUrl);
    }

    // Remote/VPS: use localhost redirect_uri and show manual auth page
    const port = getConfig().server.port;
    const localhostBase = `http://localhost:${port}`;
    const { authUrl } = generateIFlowAuthUrl(localhostBase);

    return reply.type('text/html').send(
      `<html><head>${PAGE_STYLE}</head><body><div class="box">
        <span class="tag tag-ok">远程认证</span>
        <h2>iFlow 远程授权</h2>
        <p>检测到您通过远程方式访问，请按以下步骤完成认证：</p>
        <div style="margin-top:16px;padding:14px;background:#1a1a2e;border:1px solid #333;border-radius:8px;font-size:13px;color:#ccc;line-height:1.7;text-align:left">
          <strong>步骤 1</strong>：<a href="${escapeHtml(authUrl)}" target="_blank" style="color:#7c5cf8">点击此处打开 iFlow 授权页面</a><br>
          <strong>步骤 2</strong>：完成授权后，浏览器会跳转到 <code>http://localhost:...</code> 并显示错误（这是正常的）<br>
          <strong>步骤 3</strong>：复制浏览器地址栏中的完整 URL，粘贴到下方输入框
        </div>
        <form onsubmit="return submitCallback()" style="margin-top:16px;text-align:left;">
          <input id="callbackUrl" type="text" placeholder="粘贴回调 URL (http://localhost:...?code=...)" style="width:100%;background:#111;border:1px solid #333;color:#f2f2f4;border-radius:6px;padding:10px;font-size:13px;font-family:monospace;">
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
            var r=await fetch('${baseUrl}/auth/remote/exchange',{
              method:'POST',
              headers:{'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.getItem('proxy_login_secret')||'')},
              body:JSON.stringify({provider:'iflow',callbackUrl:url})
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
   * GET /auth/iflow/callback — Handle OAuth redirect from iFlow
   */
  fastify.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    '/auth/iflow/callback',
    async (request, reply) => {
      const { code, error, state } = request.query;

      if (error) {
        return reply.type('text/html').send(
          `<html><head>${PAGE_STYLE}</head><body><div class="box">
            <span class="tag tag-err">iFlow 授权失败</span>
            <h2 class="err">iFlow 拒绝了授权</h2>
            <p>${escapeHtml(String(error))}</p>
            <a href="/">返回管理面板</a>
          </div></body></html>`
        );
      }

      if (!code || !state) {
        return reply.status(400).type('text/html').send('缺少授权码或 state');
      }

      try {
        const { email } = await exchangeIFlowCode(code, state);

        return reply.type('text/html').send(
          `<html><head>${PAGE_STYLE}</head><body><div class="box">
            <span class="tag tag-ok">iFlow 授权成功</span>
            <h2 class="ok">iFlow 认证完成</h2>
            <p>账户: ${escapeHtml(email)}</p>
            ${CALLBACK_SCRIPT('/')}
          </div></body></html>`
        );
      } catch (err: any) {
        return reply.type('text/html').send(
          `<html><head>${PAGE_STYLE}</head><body><div class="box">
            <span class="tag tag-err">iFlow 授权失败</span>
            <h2 class="err">认证出错</h2>
            <p>${escapeHtml(err.message)}</p>
            <a href="/">返回管理面板</a>
          </div></body></html>`
        );
      }
    }
  );
}
