import { createHmac } from 'crypto';
import { randomUUID } from 'crypto';
import { Provider } from '../provider.js';
import { pfetch } from '../http.js';
import { acquireCredential, reportRateLimit } from '../rotation.js';
import { getIFlowOAuthConfig, getConfig } from '../../config.js';

/**
 * Create the iFlow HMAC-SHA256 signature.
 * payload = "{userAgent}:{sessionId}:{timestamp}"
 * signature = hex(HMAC-SHA256(apiKey, payload))
 */
function createSignature(apiKey: string, sessionId: string, timestamp: number): string {
  const payload = `iFlow-Cli:${sessionId}:${timestamp}`;
  return createHmac('sha256', apiKey).update(payload).digest('hex');
}

export class IFlowProvider implements Provider {
  readonly name = 'iflow';

  async chatCompletion(model: string, request: any): Promise<any> {
    const cred = await acquireCredential({ requireProject: false, provider: 'iflow' });
    if (!cred) {
      throw new Error('未登录 iFlow，请先通过 /auth/iflow/login 认证');
    }

    const iflowConfig = getIFlowOAuthConfig();
    // iFlow stores the API key in access_token after OAuth flow
    const apiKey = cred.access_token;
    const sessionId = `session-${randomUUID()}`;
    const ts = Date.now();
    const signature = createSignature(apiKey, sessionId, ts);

    const body: any = {
      model,
      messages: request.messages,
      stream: false,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice) body.tool_choice = request.tool_choice;

    const response = await pfetch(`${iflowConfig.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'iFlow-Cli',
        'session-id': sessionId,
        'x-iflow-timestamp': String(ts),
        'x-iflow-signature': signature,
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    }, { proxyUrl: cred.proxy_url || undefined });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
        reportRateLimit(cred.account_id, retryAfter);
      }
      const errorText = await response.text();
      throw new Error(`iFlow API 错误 (${response.status}): ${errorText}`);
    }

    // iFlow returns standard OpenAI format, passthrough
    return await response.json() as any;
  }

  async chatCompletionStream(model: string, request: any): Promise<AsyncIterable<any>> {
    const cred = await acquireCredential({ requireProject: false, provider: 'iflow' });
    if (!cred) {
      throw new Error('未登录 iFlow，请先通过 /auth/iflow/login 认证');
    }

    const iflowConfig = getIFlowOAuthConfig();
    const apiKey = cred.access_token;
    const sessionId = `session-${randomUUID()}`;
    const ts = Date.now();
    const signature = createSignature(apiKey, sessionId, ts);

    const body: any = {
      model,
      messages: request.messages,
      stream: true,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice) body.tool_choice = request.tool_choice;

    const response = await pfetch(`${iflowConfig.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'iFlow-Cli',
        'session-id': sessionId,
        'x-iflow-timestamp': String(ts),
        'x-iflow-signature': signature,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    }, { proxyUrl: cred.proxy_url || undefined });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
        reportRateLimit(cred.account_id, retryAfter);
      }
      const errorText = await response.text();
      throw new Error(`iFlow API 错误 (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('iFlow 流式响应无数据');
    }

    // iFlow returns standard OpenAI SSE format, passthrough
    async function* parseStream(): AsyncIterable<any> {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') return;

            try {
              yield JSON.parse(jsonStr);
            } catch {
              // Skip malformed JSON
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    return parseStream();
  }

  isModelSupported(model: string): boolean {
    const config = getConfig();
    return config.iflow.supportedModels.some((m: string) => model.includes(m));
  }
}
