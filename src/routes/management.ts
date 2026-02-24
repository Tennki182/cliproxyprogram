import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFileSync, writeFileSync } from 'fs';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { getConfig, getConfigPath, reloadConfig } from '../config.js';
import { 
  listCredentials, 
  setCredentialPreview, 
  setCredentialValidationRequired,
  clearRateLimit,
} from '../storage/credentials.js';
import { getQueueStats } from '../services/queue.js';
import { resetProviders } from '../services/provider-factory.js';
import { resetBackend } from '../services/backend-factory.js';
import { resetHttpDispatchers } from '../services/http.js';
import { getRecentLogs, onLog, LogEntry } from '../services/log-stream.js';
import { getUsageStats } from '../services/usage.js';

// Simple usage stats (in-memory) - kept for backward compatibility
let stats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  startedAt: Date.now(),
};

export function recordRequest(success: boolean): void {
  stats.totalRequests++;
  if (success) stats.successfulRequests++;
  else stats.failedRequests++;
}

export async function managementRoutes(fastify: FastifyInstance): Promise<void> {
  // Auth check for management routes
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const urlPath = request.url.split('?')[0];
    if (!urlPath.startsWith('/v0/management')) return;

    const config = getConfig();
    if (!config.management.enabled) {
      return reply.status(404).send({ error: 'Management API disabled' });
    }

    const secret = config.management.secret || config.auth.loginSecret;
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Also support ?token= for SSE endpoints (EventSource can't set headers)
    const url = new URL(request.url, 'http://localhost');
    const queryToken = url.searchParams.get('token');

    if (token !== secret && queryToken !== secret) {
      return reply.status(401).send({ error: 'Invalid management secret' });
    }
  });

  /**
   * GET /v0/management/accounts — List all accounts with status
   */
  fastify.get('/v0/management/accounts', async () => {
    const credentials = listCredentials();
    const now = Math.floor(Date.now() / 1000);
    const usageStats = getUsageStats();

    return {
      accounts: credentials.map(c => {
        const todayStats = usageStats.getTodayStatsForCredential(c.account_id, c.provider || 'gemini');
        
        // Calculate active model cooldowns
        const activeCooldowns: Record<string, number> = {};
        if (c.model_cooldowns) {
          for (const [model, timestamp] of Object.entries(c.model_cooldowns)) {
            if (timestamp > now) {
              activeCooldowns[model] = timestamp;
            }
          }
        }
        
        const provider = c.provider || 'gemini';
        return {
          account_id: c.account_id,
          provider,
          project_id: c.project_id,
          has_refresh_token: !!c.refresh_token,
          is_expired: !!(c.expires_at && c.expires_at < Date.now()),
          is_rate_limited: !!(c.rate_limited_until && c.rate_limited_until > now),
          rate_limited_until: c.rate_limited_until || 0,
          last_used_at: c.last_used_at || 0,
          proxy_url: c.proxy_url || null,
          // preview 仅对 gemini 有效
          preview: provider === 'gemini' ? (c.preview !== false) : undefined,
          validation_required: c.validation_required || false,
          validation_url: c.validation_url || null,
          model_cooldowns: activeCooldowns,
          today_requests: todayStats.totalRequests,
          today_tokens: todayStats.totalTokens,
        };
      }),
    };
  });

  /**
   * GET /v0/management/stats — Basic usage statistics (backward compatible)
   */
  fastify.get('/v0/management/stats', async () => {
    const queue = getQueueStats();
    const config = getConfig();
    const usageStats = getUsageStats();
    const globalStats = usageStats.getGlobalStats();

    return {
      uptime_seconds: Math.floor((Date.now() - stats.startedAt) / 1000),
      total_requests: globalStats.totalRequests,
      successful_requests: globalStats.successCount,
      failed_requests: globalStats.failureCount,
      total_tokens: globalStats.totalTokens,
      queue: {
        pending: queue.pending,
        running: queue.running,
      },
      routing_strategy: config.routing.strategy,
      backend: config.gemini.backend,
      providers: {
        gemini: true,
        codex: config.codex.enabled,
        iflow: config.iflow.enabled,
      },
    };
  });

  /**
   * GET /v0/management/usage — Detailed usage statistics
   */
  fastify.get('/v0/management/usage', async () => {
    const usageStats = getUsageStats();
    
    return {
      global: usageStats.getGlobalStats(),
      credentials: usageStats.getCredentialStats(),
      daily: usageStats.getDailyStats(30),
      hourly: usageStats.getHourlyStats(),
    };
  });

  /**
   * GET /v0/management/usage/credentials — Stats grouped by credential
   */
  fastify.get('/v0/management/usage/credentials', async () => {
    const usageStats = getUsageStats();
    return {
      credentials: usageStats.getCredentialStats(),
    };
  });

  /**
   * GET /v0/management/usage/daily — Daily stats for last N days
   */
  fastify.get<{ Querystring: { days?: string } }>('/v0/management/usage/daily', async (request) => {
    const days = parseInt(request.query.days || '30', 10);
    const usageStats = getUsageStats();
    return {
      daily: usageStats.getDailyStats(days),
    };
  });

  /**
   * GET /v0/management/usage/hourly — Today's hourly stats
   */
  fastify.get('/v0/management/usage/hourly', async () => {
    const usageStats = getUsageStats();
    return {
      hourly: usageStats.getHourlyStats(),
    };
  });

  /**
   * GET /v0/management/history — Recent request history
   */
  fastify.get<{ Querystring: { limit?: string } }>('/v0/management/history', async (request) => {
    const limit = parseInt(request.query.limit || '100', 10);
    const usageStats = getUsageStats();
    return {
      history: usageStats.getRequestHistory(limit),
    };
  });

  /**
   * POST /v0/management/reload — Force config reload
   */
  fastify.post('/v0/management/reload', async (_request, reply) => {
    const newConfig = reloadConfig();
    if (newConfig) {
      resetProviders();
      resetBackend();
      resetHttpDispatchers();
      return { success: true, message: 'Config reloaded' };
    }
    return reply.status(500).send({ error: 'Config reload failed' });
  });

  /**
   * GET /v0/management/config — View current config (redacted)
   */
  fastify.get('/v0/management/config', async () => {
    const config = getConfig();
    return {
      server: config.server,
      gemini: {
        backend: config.gemini.backend,
        defaultModel: config.gemini.defaultModel,
        supportedModels: config.gemini.supportedModels,
        modelAliases: config.gemini.modelAliases,
        excludedModels: config.gemini.excludedModels,
      },
      codex: {
        enabled: config.codex.enabled,
        supportedModels: config.codex.supportedModels,
      },
      iflow: {
        enabled: config.iflow.enabled,
        supportedModels: config.iflow.supportedModels,
      },
      routing: config.routing,
      retry: config.retry,
      tls: { enabled: config.tls.enabled },
      management: { enabled: config.management.enabled },
    };
  });

  /**
   * GET /v0/management/logs — SSE stream of real-time logs
   */
  fastify.get('/v0/management/logs', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send recent history first
    for (const entry of getRecentLogs()) {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Stream new logs
    const cleanup = onLog((entry: LogEntry) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch {
        cleanup();
      }
    });

    // Keep-alive every 20s
    const keepAlive = setInterval(() => {
      try { reply.raw.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
    }, 20000);

    request.raw.on('close', () => {
      cleanup();
      clearInterval(keepAlive);
    });
  });

  /**
   * PATCH /v0/management/providers/:provider — Toggle provider enabled/disabled
   * Body: { enabled: boolean }
   * Supported providers: codex, iflow (gemini is always enabled)
   */
  fastify.patch<{
    Params: { provider: string };
    Body: { enabled: boolean };
  }>('/v0/management/providers/:provider', async (request, reply) => {
    const { provider } = request.params;
    const { enabled } = request.body;

    const allowedProviders = ['codex', 'iflow'];
    if (!allowedProviders.includes(provider)) {
      return reply.status(400).send({ error: `不支持的 provider: ${provider}。Gemini 始终启用，不可关闭。` });
    }
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled 必须是布尔值' });
    }

    try {
      const configPathVal = getConfigPath();
      const raw = readFileSync(configPathVal, 'utf-8');
      const parsed = yamlParse(raw) || {};

      if (!parsed[provider]) parsed[provider] = {};
      parsed[provider].enabled = enabled;

      writeFileSync(configPathVal, yamlStringify(parsed), 'utf-8');

      const newConfig = reloadConfig();
      if (newConfig) {
        resetProviders();
        resetBackend();
        resetHttpDispatchers();
      }

      return { success: true, provider, enabled };
    } catch (e: any) {
      return reply.status(500).send({ error: '更新 config.yaml 失败: ' + e.message });
    }
  });

  /**
   * PATCH /v0/management/providers/:provider/excluded-models — Add/remove excluded model
   * Body: { model: string, action: 'add' | 'remove' }
   */
  fastify.patch<{
    Params: { provider: string };
    Body: { model: string; action: 'add' | 'remove' };
  }>('/v0/management/providers/:provider/excluded-models', async (request, reply) => {
    const { provider } = request.params;
    const { model, action } = request.body;

    const allowedProviders = ['gemini', 'codex', 'iflow'];
    if (!allowedProviders.includes(provider)) {
      return reply.status(400).send({ error: `不支持的 provider: ${provider}` });
    }
    if (!model || typeof model !== 'string') {
      return reply.status(400).send({ error: 'model 必须是非空字符串' });
    }
    if (action !== 'add' && action !== 'remove') {
      return reply.status(400).send({ error: 'action 必须是 "add" 或 "remove"' });
    }

    try {
      const configPathVal = getConfigPath();
      const raw = readFileSync(configPathVal, 'utf-8');
      const parsed = yamlParse(raw) || {};

      if (!parsed[provider]) parsed[provider] = {};
      if (!Array.isArray(parsed[provider].excludedModels)) {
        parsed[provider].excludedModels = [];
      }

      const list: string[] = parsed[provider].excludedModels;
      if (action === 'add') {
        if (!list.includes(model)) {
          list.push(model);
        }
      } else {
        const idx = list.indexOf(model);
        if (idx !== -1) {
          list.splice(idx, 1);
        }
      }

      writeFileSync(configPathVal, yamlStringify(parsed), 'utf-8');

      const newConfig = reloadConfig();
      if (newConfig) {
        resetProviders();
        resetBackend();
        resetHttpDispatchers();
      }

      return { success: true, provider, model, action, excludedModels: list };
    } catch (e: any) {
      return reply.status(500).send({ error: '更新 config.yaml 失败: ' + e.message });
    }
  });

  /**
   * PATCH /v0/management/accounts/:account_id/preview — Set preview status for a credential
   * Body: { preview: boolean }
   */
  fastify.patch<{
    Params: { account_id: string };
    Body: { preview: boolean };
  }>('/v0/management/accounts/:account_id/preview', async (request, reply) => {
    const { account_id } = request.params;
    const { preview } = request.body;

    if (typeof preview !== 'boolean') {
      return reply.status(400).send({ error: 'preview 必须是布尔值' });
    }

    try {
      setCredentialPreview(account_id, preview, 'gemini');
      return { 
        success: true, 
        account_id, 
        preview,
        message: `凭证 ${account_id} 的 preview 状态已设置为 ${preview}` 
      };
    } catch (e: any) {
      return reply.status(500).send({ error: '更新 preview 状态失败: ' + e.message });
    }
  });

  /**
   * POST /v0/management/accounts/:account_id/validate — Clear validation required status
   * Call this after manually verifying the account
   */
  fastify.post<{
    Params: { account_id: string };
  }>('/v0/management/accounts/:account_id/validate', async (request, reply) => {
    const { account_id } = request.params;

    try {
      setCredentialValidationRequired(account_id, false, undefined, 'gemini');
      // Also clear any rate limit
      clearRateLimit(account_id, 'gemini');
      
      return { 
        success: true, 
        account_id,
        message: `凭证 ${account_id} 的验证状态已清除，可以重新使用` 
      };
    } catch (e: any) {
      return reply.status(500).send({ error: '清除验证状态失败: ' + e.message });
    }
  });

  /**
   * POST /v0/management/accounts/:account_id/reset — Reset credential status (clear errors and cooldowns)
   */
  fastify.post<{
    Params: { account_id: string };
  }>('/v0/management/accounts/:account_id/reset', async (request, reply) => {
    const { account_id } = request.params;

    try {
      clearRateLimit(account_id, 'gemini');
      
      return { 
        success: true, 
        account_id,
        message: `凭证 ${account_id} 的状态已重置` 
      };
    } catch (e: any) {
      return reply.status(500).send({ error: '重置凭证状态失败: ' + e.message });
    }
  });
}
