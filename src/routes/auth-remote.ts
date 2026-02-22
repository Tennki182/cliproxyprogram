import { FastifyInstance } from 'fastify';
import { getAuthorizationUrl, exchangeCodeForTokens } from '../services/auth.js';
import { generatePkce, exchangeCodexCode } from './auth-codex.js';
import { generateIFlowAuthUrl, exchangeIFlowCode } from './auth-iflow.js';
import { getCodexOAuthConfig, getConfig } from '../config.js';
import { logInfo, logError } from '../services/log-stream.js';

function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return '';
  return authHeader.slice(7);
}

function checkLoginSecret(request: { headers: { authorization?: string } }, reply: any): boolean {
  const config = getConfig();
  if (!config.auth.loginSecret) return true;
  const token = extractBearerToken(request.headers.authorization);
  if (token !== config.auth.loginSecret) {
    reply.status(401).send({ error: '未授权' });
    return false;
  }
  return true;
}

export async function remoteAuthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /auth/remote/init?provider=gemini|codex|iflow
   * Generate an OAuth auth URL with a localhost redirect_uri.
   * Used when the admin panel is accessed remotely (VPS).
   */
  fastify.get<{ Querystring: { provider?: string } }>(
    '/auth/remote/init',
    async (request, reply) => {
      if (!checkLoginSecret(request, reply)) return;

      const { provider } = request.query;
      if (!provider) {
        return reply.status(400).send({ error: '缺少 provider 参数' });
      }

      const port = getConfig().server.port;

      if (provider === 'gemini') {
        const authUrl = getAuthorizationUrl('');
        return { authUrl, redirectUri: 'http://localhost:8085/oauth2callback' };
      }

      if (provider === 'codex') {
        const { challenge, state } = generatePkce();
        const codexConfig = getCodexOAuthConfig();
        const redirectUri = 'http://localhost:1455/auth/callback';
        const params = new URLSearchParams({
          client_id: codexConfig.clientId,
          response_type: 'code',
          redirect_uri: redirectUri,
          scope: 'openid email profile offline_access',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          prompt: 'login',
          id_token_add_organizations: 'true',
          codex_cli_simplified_flow: 'true',
        });
        return {
          authUrl: `${codexConfig.authEndpoint}?${params.toString()}`,
          redirectUri,
        };
      }

      if (provider === 'iflow') {
        const localhostBase = `http://localhost:${port}`;
        const { authUrl } = generateIFlowAuthUrl(localhostBase);
        return { authUrl, redirectUri: `${localhostBase}/auth/iflow/callback` };
      }

      return reply.status(400).send({ error: '不支持的 provider' });
    }
  );

  /**
   * POST /auth/remote/exchange
   * Accept { provider, callbackUrl }, extract code/state, complete token exchange.
   */
  fastify.post<{ Body: { provider?: string; callbackUrl?: string } }>(
    '/auth/remote/exchange',
    async (request, reply) => {
      if (!checkLoginSecret(request, reply)) return;

      const { provider, callbackUrl } = request.body || {};
      if (!provider || !callbackUrl) {
        return reply.status(400).send({ error: '缺少 provider 或 callbackUrl' });
      }

      let url: URL;
      try {
        url = new URL(callbackUrl);
      } catch {
        return reply.status(400).send({ error: '无效的 URL 格式' });
      }

      try {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          return reply.status(400).send({ error: `OAuth 被拒绝: ${error}` });
        }

        if (!code) {
          return reply.status(400).send({ error: '回调 URL 中缺少 code 参数' });
        }

        if (provider === 'gemini') {
          const credential = await exchangeCodeForTokens(code, '');
          logInfo(`远程 Gemini 认证成功: ${credential.account_id}`);
          return { success: true, accountId: credential.account_id, projectId: credential.project_id };
        }

        if (provider === 'codex') {
          if (!state) return reply.status(400).send({ error: '回调 URL 中缺少 state 参数' });
          const { accountId } = await exchangeCodexCode(code, state);
          logInfo(`远程 Codex 认证成功: ${accountId}`);
          return { success: true, accountId };
        }

        if (provider === 'iflow') {
          if (!state) return reply.status(400).send({ error: '回调 URL 中缺少 state 参数' });
          const { email } = await exchangeIFlowCode(code, state);
          logInfo(`远程 iFlow 认证成功: ${email}`);
          return { success: true, accountId: email };
        }

        return reply.status(400).send({ error: '不支持的 provider' });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError(`远程认证失败 (${provider}): ${errMsg}`);
        return reply.status(500).send({ error: errMsg });
      }
    }
  );
}
