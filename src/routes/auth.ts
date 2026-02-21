import { FastifyInstance } from 'fastify';
import { getAuthorizationUrl, exchangeCodeForTokens, getCredentialStatus, refreshAccessToken } from '../services/auth.js';
import { listCredentials, deleteCredential, getActiveCredential } from '../storage/credentials.js';
import { getAccountSessions, deleteSession } from '../storage/sessions.js';
import { getConfig } from '../config.js';
import { readFileSync, writeFileSync } from 'fs';
import { parse, stringify } from 'yaml';
import { getConfigPath } from '../config.js';

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
  .hint{margin-top:16px;padding:14px;background:#1a1a2e;border:1px solid #333;border-radius:8px;font-size:13px;color:#ccc;line-height:1.7;text-align:left}
  code{background:#222;padding:2px 6px;border-radius:4px;font-size:12px}
  .tag{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;margin-bottom:12px}
  .tag-ok{background:rgba(52,211,153,.12);color:#34d399}
  .tag-err{background:rgba(251,113,133,.12);color:#fb7185}
</style>`;

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Extract base URL from the incoming request (supports reverse proxy headers)
   */
  function getBaseUrl(request: import('fastify').FastifyRequest): string {
    const proto = (request.headers['x-forwarded-proto'] as string) || request.protocol || 'http';
    const host = (request.headers['x-forwarded-host'] as string) || request.headers.host || `localhost:${getConfig().server.port}`;
    return `${proto}://${host}`;
  }

  /** HTML snippet: notify opener window (new-tab auth flow) then close/redirect */
  const CALLBACK_SCRIPT = (fallbackUrl: string) =>
    `<script>
      if(window.opener){window.opener.postMessage({type:'auth-complete'},location.origin);setTimeout(()=>window.close(),1500)}
      else{setTimeout(()=>{window.location.href='${fallbackUrl}'},1500)}
    </script>`;

  /**
   * GET /auth/login - Redirect to Google OAuth consent screen
   */
  fastify.get('/auth/login', async (request, reply) => {
    const baseUrl = getBaseUrl(request);
    const authUrl = getAuthorizationUrl(baseUrl);
    return reply.redirect(authUrl);
  });

  /**
   * GET /auth/callback - Handle OAuth redirect from Google
   */
  fastify.get<{ Querystring: { code?: string; error?: string; state?: string } }>(
    '/auth/callback',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            error: { type: 'string' },
            state: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { code, error } = request.query;
      const baseUrl = getBaseUrl(request);

      if (error) {
        return reply.type('text/html').send(
          `<html><head>${PAGE_STYLE}</head><body><div class="box">
            <span class="tag tag-err">授权失败</span>
            <h2 class="err">Google 拒绝了授权</h2>
            <p>${escapeHtml(String(error))}</p>
            <a href="/">返回管理面板</a>
          </div></body></html>`
        );
      }

      if (!code) {
        return reply.status(400).send({ error: '缺少授权码' });
      }

      try {
        const credential = await exchangeCodeForTokens(code, baseUrl);

        return reply.type('text/html').send(
          `<html><head>${PAGE_STYLE}</head><body><div class="box">
            <span class="tag tag-ok">授权成功</span>
            <h2 class="ok">认证完成</h2>
            <p>账户: ${escapeHtml(credential.account_id)}</p>
            ${credential.project_id ? `<p>项目: <code>${escapeHtml(credential.project_id)}</code></p>` : '<p style="color:#fbbf24">未发现项目 (可能需要启用 Cloud AI Companion API)</p>'}
            <p style="color:#555;font-size:12px;margin-top:8px">正在跳转...</p>
            ${CALLBACK_SCRIPT('/')}
          </div></body></html>`
        );
      } catch (error: any) {
        fastify.log.error(error);
        const msg = error.message || '未知错误';
        const isNetworkError = msg.includes('Network error') || msg.includes('fetch failed');
        const proxyHint = isNetworkError
          ? `<div class="hint">
              <strong style="color:#fbbf24">网络错误</strong><br>
              服务器无法连接 Google API，请在 <code style="color:#22d3ee">config.yaml</code> 中配置代理：<br>
              <code style="color:#34d399;display:inline-block;margin-top:4px">proxy: "http://127.0.0.1:7890"</code><br>
              <span style="font-size:12px;color:#888">或设置 HTTPS_PROXY 环境变量后重启服务</span>
            </div>`
          : '';
        return reply.type('text/html').send(
          `<html><head>${PAGE_STYLE}</head><body><div class="box">
            <span class="tag tag-err">授权失败</span>
            <h2 class="err">认证出错</h2>
            <p>${escapeHtml(msg)}</p>
            ${proxyHint}
            <br><a href="/">返回管理面板</a>
          </div></body></html>`
        );
      }
    }
  );

  /**
   * GET /auth/status - Get current credential status
   */
  fastify.get('/auth/status', async (_request, _reply) => {
    const status = getCredentialStatus();
    return status;
  });

  /**
   * POST /auth/refresh - Refresh current credentials
   */
  fastify.post('/auth/refresh', async (_request, reply) => {
    const credential = getActiveCredential();

    if (!credential || !credential.refresh_token) {
      return reply.status(400).send({ error: '没有可用的刷新令牌' });
    }

    try {
      const newCredential = await refreshAccessToken(credential.refresh_token);
      return {
        success: true,
        account_id: newCredential.account_id,
        project_id: newCredential.project_id,
      };
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  /**
   * POST /auth/verify - Verify login secret (no auth required)
   */
  fastify.post<{ Body: { secret: string } }>(
    '/auth/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['secret'],
          properties: {
            secret: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const config = getConfig();
      if (!config.auth.loginSecret) return { valid: true };
      return { valid: request.body.secret === config.auth.loginSecret };
    }
  );

  /**
   * GET /auth/settings - Get current auth settings (apiKey visible for copy)
   */
  fastify.get('/auth/settings', async () => {
    const config = getConfig();
    return {
      apiKey: config.auth.apiKey,
      loginSecret: config.auth.loginSecret,
    };
  });

  /**
   * POST /auth/settings - Update API key and/or login secret
   */
  fastify.post<{ Body: { apiKey?: string; loginSecret?: string } }>(
    '/auth/settings',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            apiKey: { type: 'string' },
            loginSecret: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { apiKey, loginSecret } = request.body;
      if (apiKey === undefined && loginSecret === undefined) {
        return reply.status(400).send({ error: '请至少提供一个字段' });
      }

      try {
        const configFile = getConfigPath();
        const fileContent = readFileSync(configFile, 'utf-8');
        const parsed = parse(fileContent);

        if (!parsed.auth) parsed.auth = {};
        // Remove deprecated 'password' key
        delete parsed.auth.password;
        if (apiKey !== undefined) parsed.auth.apiKey = apiKey;
        if (loginSecret !== undefined) parsed.auth.loginSecret = loginSecret;

        writeFileSync(configFile, stringify(parsed), 'utf-8');

        return { success: true, message: '设置已保存' };
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  /**
   * GET /auth/accounts - List all accounts
   */
  fastify.get('/auth/accounts', async (_request, _reply) => {
    const credentials = listCredentials();
    return {
      accounts: credentials.map(c => ({
        account_id: c.account_id,
        project_id: c.project_id,
        expires_at: c.expires_at,
        has_refresh_token: !!c.refresh_token,
        provider: c.provider || 'gemini',
        proxy_url: c.proxy_url || null,
      })),
    };
  });

  /**
   * DELETE /auth/accounts/:accountId - Delete an account
   */
  fastify.delete<{ Params: { accountId: string }; Querystring: { provider?: string } }>(
    '/auth/accounts/:accountId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { accountId } = request.params;
      const { provider } = request.query;

      try {
        deleteCredential(accountId, provider);
        return { success: true };
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  /**
   * GET /auth/sessions - List sessions for current account
   */
  fastify.get('/auth/sessions', async (_request, _reply) => {
    const credential = getActiveCredential();

    if (!credential) {
      return { sessions: [] };
    }

    const sessions = getAccountSessions(credential.account_id);
    return {
      sessions: sessions.map(s => ({
        session_id: s.session_id,
        message_count: JSON.parse(s.messages || '[]').length,
        updated_at: s.updated_at,
      })),
    };
  });

  /**
   * DELETE /auth/sessions/:sessionId - Delete a session
   */
  fastify.delete<{ Params: { sessionId: string } }>(
    '/auth/sessions/:sessionId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params;

      try {
        deleteSession(sessionId);
        return { success: true };
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );
}
