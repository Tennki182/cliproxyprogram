import { createHmac } from 'crypto';
import { randomUUID } from 'crypto';
import { Provider } from '../provider.js';
import { pfetch } from '../http.js';
import { acquireCredential, reportRateLimit } from '../rotation.js';
import { getIFlowOAuthConfig, getConfig } from '../../config.js';
import { getCredential as getStoredCredential, saveCredential, listCredentials } from '../../storage/credentials.js';
import { formatErrorMessage, logWarn, logInfo } from '../log-stream.js';
import { calculateRequestTokens, countRequestInputTokens } from '../token-counter.js';
import { getBaseModelName, getThinkingSettingsFromModel } from '../converter.js';

interface IFlowTokenData {
  access_token: string;
  refresh_token?: string;
  api_key?: string;
  expires_at?: number;
  expire?: string;
}

interface IFlowCookieData {
  api_key: string;
  expire_time: string;
}

/**
 * Create the iFlow HMAC-SHA256 signature.
 * payload = "{userAgent}:{sessionId}:{timestamp}"
 * signature = hex(HMAC-SHA256(apiKey, payload))
 */
function createSignature(apiKey: string, sessionId: string, timestamp: number): string {
  const payload = `iFlow-Cli:${sessionId}:${timestamp}`;
  return createHmac('sha256', apiKey).update(payload).digest('hex');
}

/**
 * Parse expiration time from iFlow format
 */
function parseExpireTime(expire: string): number {
  try {
    // Try parsing as ISO date
    const date = new Date(expire);
    if (!isNaN(date.getTime())) {
      return Math.floor(date.getTime() / 1000);
    }
  } catch {
    // Fallback: return 1 hour from now
  }
  return Math.floor(Date.now() / 1000) + 3600;
}

/**
 * Refresh iFlow API key using cookie
 */
async function refreshCookieBasedAPIKey(cookie: string, email: string): Promise<IFlowCookieData> {
  const config = getIFlowOAuthConfig();
  
  const response = await pfetch(`${config.apiBase}/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
    },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    throw new Error(`Cookie refresh failed: ${response.status}`);
  }

  const data = await response.json() as Record<string, any>;
  return {
    api_key: data.api_key,
    expire_time: data.expire_time || data.expires_at,
  };
}

/**
 * Refresh iFlow tokens using refresh token
 */
async function refreshOAuthTokens(refreshToken: string): Promise<IFlowTokenData> {
  const config = getIFlowOAuthConfig();
  
  const response = await pfetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = await response.json() as Record<string, any>;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    api_key: data.api_key,
    expires_at: data.expires_at ? Math.floor(data.expires_at / 1000) : undefined,
    expire: data.expire,
  };
}

/**
 * Preserve reasoning content in messages for multi-turn conversations
 * This helps models like GLM-4.6/4.7 and MiniMax M2/M1 maintain coherent thought chains
 */
function preserveReasoningContent(messages: any[]): any[] {
  if (!messages || messages.length === 0) return messages;
  
  // Check if any model supports reasoning with history preservation
  // For now, we always preserve reasoning_content if present
  const processedMessages = [];
  
  for (const msg of messages) {
    const newMsg = { ...msg };
    
    // If assistant message has reasoning_content, ensure it's preserved
    if (msg.role === 'assistant' && msg.reasoning_content) {
      // Keep reasoning_content in the message
      newMsg.reasoning_content = msg.reasoning_content;
    }
    
    processedMessages.push(newMsg);
  }
  
  return processedMessages;
}

/**
 * Ensure tools array is not empty to avoid provider quirks
 */
function ensureToolsArray(body: any): any {
  if (body.tools && Array.isArray(body.tools) && body.tools.length === 0) {
    // Add a placeholder tool to stabilize streaming
    return {
      ...body,
      tools: [{
        type: 'function',
        function: {
          name: 'noop',
          description: 'Placeholder tool to stabilize streaming',
          parameters: { type: 'object' },
        },
      }],
    };
  }
  return body;
}

function isGLMModel(model: string): boolean {
  return getBaseModelName(model).toLowerCase().startsWith('glm');
}

function isMiniMaxModel(model: string): boolean {
  return getBaseModelName(model).toLowerCase().startsWith('minimax');
}

function usesEnableThinkingModel(model: string): boolean {
  const baseModel = getBaseModelName(model).toLowerCase();
  if (baseModel.startsWith('glm')) {
    return true;
  }

  return baseModel === 'qwen3-max-preview'
    || baseModel === 'deepseek-v3.1'
    || baseModel === 'deepseek-v3.2';
}

function resolveIFlowThinkingEnabled(model: string, request: any): boolean | undefined {
  if (request.reasoning_effort !== undefined) {
    return request.reasoning_effort !== 'none';
  }

  if (request.thinking_budget !== undefined) {
    return request.thinking_budget !== 0;
  }

  const thinkingSettings = getThinkingSettingsFromModel(model);
  if (!thinkingSettings) {
    return undefined;
  }

  if (thinkingSettings.thinkingBudget !== undefined) {
    return thinkingSettings.thinkingBudget !== 0;
  }

  if (thinkingSettings.thinkingLevel !== undefined) {
    return thinkingSettings.thinkingLevel !== 'none';
  }

  return undefined;
}

function applyIFlowThinkingConfig(body: any, model: string, request: any): any {
  const thinkingEnabled = resolveIFlowThinkingEnabled(model, request);
  if (thinkingEnabled === undefined) {
    return body;
  }

  if (isMiniMaxModel(model)) {
    const nextBody = { ...body, reasoning_split: thinkingEnabled };
    if (nextBody.chat_template_kwargs) {
      const nextChatTemplateKwargs = { ...nextBody.chat_template_kwargs };
      delete nextChatTemplateKwargs.enable_thinking;
      delete nextChatTemplateKwargs.clear_thinking;
      if (Object.keys(nextChatTemplateKwargs).length > 0) {
        nextBody.chat_template_kwargs = nextChatTemplateKwargs;
      } else {
        delete nextBody.chat_template_kwargs;
      }
    }
    return nextBody;
  }

  if (!usesEnableThinkingModel(model)) {
    return body;
  }

  const nextChatTemplateKwargs = {
    ...(body.chat_template_kwargs || {}),
    enable_thinking: thinkingEnabled,
  };

  if (thinkingEnabled && isGLMModel(model)) {
    nextChatTemplateKwargs.clear_thinking = false;
  } else {
    delete nextChatTemplateKwargs.clear_thinking;
  }

  return {
    ...body,
    chat_template_kwargs: nextChatTemplateKwargs,
  };
}

export class IFlowProvider implements Provider {
  readonly name = 'iflow';

  private async refreshIfNeeded(cred: any): Promise<any> {
    const stored = getStoredCredential(cred.account_id);
    if (!stored) return cred;
    
    // Check for cookie-based authentication
    const cookie = stored.refresh_token?.startsWith('cookie:') 
      ? stored.refresh_token.substring(7) 
      : undefined;
    // Email is stored in scope field for cookie auth (TODO: use separate email field)
    const email = stored.scope;
    
    // Check for OAuth refresh token
    const refreshToken = stored.refresh_token && !stored.refresh_token.startsWith('cookie:')
      ? stored.refresh_token
      : undefined;
    
    // Check if refresh is needed
    const needsRefresh = stored.expires_at && (stored.expires_at - Math.floor(Date.now() / 1000) < 300);
    
    if (!needsRefresh) return cred;
    
    try {
      if (cookie && email) {
        logInfo(`[iFlow] Refreshing cookie-based API key for ${email}`);
        const keyData = await refreshCookieBasedAPIKey(cookie, email);
        
        // Update stored credential
        const updated = {
          ...stored,
          access_token: keyData.api_key,
          expires_at: parseExpireTime(keyData.expire_time),
          updated_at: Math.floor(Date.now() / 1000),
        };
        saveCredential(updated);
        
        return { ...cred, access_token: keyData.api_key };
      } else if (refreshToken) {
        logInfo(`[iFlow] Refreshing OAuth tokens for ${cred.account_id}`);
        const tokenData = await refreshOAuthTokens(refreshToken);
        
        // Update stored credential
        const updated = {
          ...stored,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || refreshToken,
          expires_at: tokenData.expires_at || Math.floor(Date.now() / 1000) + 3600,
          updated_at: Math.floor(Date.now() / 1000),
        };
        saveCredential(updated);
        
        return { ...cred, access_token: tokenData.access_token };
      }
    } catch (error: any) {
      logWarn(`[iFlow] Failed to refresh credentials: ${error.message}`);
    }
    
    return cred;
  }

  async chatCompletion(model: string, request: any): Promise<any> {
    const actualModel = getBaseModelName(model);
    const errors: Array<{ accountId: string; statusCode: number; message: string }> = [];
    const triedCredentials = new Set<string>();
    let attemptCount = 0;
    
    // Get all available iFlow credentials
    const allCredentials = listCredentials().filter(c => c.provider === 'iflow');
    const totalCredentials = allCredentials.length;
    
    if (totalCredentials === 0) {
      throw new Error('未登录 iFlow，请先通过 /auth/iflow/login 认证');
    }
    
    // Get initial credential
    let cred = await acquireCredential({ requireProject: false, provider: 'iflow' });
    if (!cred) {
      throw new Error('未登录 iFlow，请先通过 /auth/iflow/login 认证');
    }
    
    // Main retry loop - try all credentials
    while (attemptCount < totalCredentials && cred) {
      const credKey = `${cred.account_id}:iflow`;
      
      // Skip if already tried this credential
      if (triedCredentials.has(credKey)) {
        const nextCred = await acquireCredential({ requireProject: false, provider: 'iflow' });
        if (nextCred && `${nextCred.account_id}:iflow` !== credKey) {
          cred = nextCred;
          continue;
        }
        break;
      }
      
      triedCredentials.add(credKey);
      attemptCount++;
      
      const accountId = cred.account_id;
      
      // Log which credential is being used
      if (attemptCount === 1) {
        logWarn(`[iFlow] 使用凭证 [${accountId}] 发起请求 (共 ${totalCredentials} 个凭证可用)`);
      } else {
        logWarn(`[iFlow] 重试 #${attemptCount}: 切换到凭证 [${accountId}]`);
      }
      
      // Refresh credentials if needed
      cred = await this.refreshIfNeeded(cred);
      if (!cred) break;
      
      const iflowConfig = getIFlowOAuthConfig();
      const apiKey = cred.access_token;
      const sessionId = `session-${randomUUID()}`;
      const ts = Date.now();
      const signature = createSignature(apiKey, sessionId, ts);
      
      // Preserve reasoning content for multi-turn conversations
      const messages = preserveReasoningContent(request.messages);
      
      let body: any = {
        model: actualModel,
        messages,
        stream: false,
      };
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.top_p !== undefined) body.top_p = request.top_p;
      if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
      if (request.tools) body.tools = request.tools;
      if (request.tool_choice) body.tool_choice = request.tool_choice;
      
      // Ensure tools array is not empty
      body = ensureToolsArray(body);
      body = applyIFlowThinkingConfig(body, model, request);
      
      try {
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
          const errorText = await response.text();
          const statusCode = response.status;
          errors.push({ accountId, statusCode, message: errorText });
          
          // Handle 429 - wait 1s then try next credential
          if (statusCode === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '1', 10);
            logWarn(`[iFlow] 凭证 [${accountId}] 触发限流 (429)，冷却 ${retryAfter}s`);
            reportRateLimit(accountId, retryAfter);
            
            // Wait 1s before retry
            await new Promise(r => setTimeout(r, 1000));
            
            const nextCred = await acquireCredential({ requireProject: false, provider: 'iflow' });
            if (nextCred && `${nextCred.account_id}:iflow` !== credKey) {
              cred = nextCred;
              continue;
            }
            break;
          }
          
          // Other errors - try next credential
          logWarn(`[iFlow] 凭证 [${accountId}] 返回 ${statusCode}，切换下一个凭证...`);
          const nextCred = await acquireCredential({ requireProject: false, provider: 'iflow' });
          if (nextCred && `${nextCred.account_id}:iflow` !== credKey) {
            cred = nextCred;
            continue;
          }
          break;
        }
        
        // iFlow returns standard OpenAI format, passthrough
        const result = await response.json() as any;
        
        // Ensure usage is present (estimate if missing)
        if (!result.usage) {
          const estimated = calculateRequestTokens(request);
          result.usage = {
            prompt_tokens: estimated.prompt_tokens,
            completion_tokens: estimated.completion_tokens,
            total_tokens: estimated.total_tokens,
            estimated: true,
          };
        }
        
        return result;
      } catch (error: any) {
        const errorMessage = formatErrorMessage(error);
        errors.push({ accountId, statusCode: 0, message: errorMessage });
        logWarn(`[iFlow] 凭证 [${accountId}] 请求错误: ${errorMessage}，切换下一个凭证...`);
        
        const nextCred = await acquireCredential({ requireProject: false, provider: 'iflow' });
        if (nextCred && `${nextCred.account_id}:iflow` !== credKey) {
          cred = nextCred;
          continue;
        }
        break;
      }
    }
    
    // All credentials exhausted
    const errorSummary = errors.map(e => `[${e.accountId}] ${e.statusCode}: ${e.message}`).join('\n');
    throw new Error(`[iFlow] 所有 ${totalCredentials} 个凭证均请求失败。错误汇总: ${errorSummary || '未知错误'}`);
  }

  async chatCompletionStream(model: string, request: any): Promise<AsyncIterable<any>> {
    const actualModel = getBaseModelName(model);
    const errors: Array<{ accountId: string; statusCode: number; message: string }> = [];
    const triedCredentials = new Set<string>();
    let attemptCount = 0;
    
    // Get all available iFlow credentials
    const allCredentials = listCredentials().filter(c => c.provider === 'iflow');
    const totalCredentials = allCredentials.length;
    
    if (totalCredentials === 0) {
      throw new Error('未登录 iFlow，请先通过 /auth/iflow/login 认证');
    }
    
    // Get initial credential
    let cred = await acquireCredential({ requireProject: false, provider: 'iflow' });
    if (!cred) {
      throw new Error('未登录 iFlow，请先通过 /auth/iflow/login 认证');
    }
    
    // Main retry loop - try all credentials
    while (attemptCount < totalCredentials && cred) {
      const credKey = `${cred.account_id}:iflow`;
      
      // Skip if already tried this credential
      if (triedCredentials.has(credKey)) {
        const nextCred = await acquireCredential({ requireProject: false, provider: 'iflow' });
        if (nextCred && `${nextCred.account_id}:iflow` !== credKey) {
          cred = nextCred;
          continue;
        }
        break;
      }
      
      triedCredentials.add(credKey);
      attemptCount++;
      
      const accountId = cred.account_id;
      
      // Log which credential is being used
      if (attemptCount === 1) {
        logWarn(`[iFlow] 使用凭证 [${accountId}] 发起流式请求 (共 ${totalCredentials} 个凭证可用)`);
      } else {
        logWarn(`[iFlow] 重试 #${attemptCount}: 切换到凭证 [${accountId}]`);
      }
      
      // Refresh credentials if needed
      cred = await this.refreshIfNeeded(cred);
      if (!cred) break;
      
      const iflowConfig = getIFlowOAuthConfig();
      const apiKey = cred.access_token;
      const sessionId = `session-${randomUUID()}`;
      const ts = Date.now();
      const signature = createSignature(apiKey, sessionId, ts);
      
      // Preserve reasoning content for multi-turn conversations
      const messages = preserveReasoningContent(request.messages);
      
      // Calculate estimated tokens for usage tracking
      const estimatedTokens = countRequestInputTokens({
        messages,
        tools: request.tools,
      });
      
      let body: any = {
        model: actualModel,
        messages,
        stream: true,
      };
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.top_p !== undefined) body.top_p = request.top_p;
      if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
      if (request.tools) body.tools = request.tools;
      if (request.tool_choice) body.tool_choice = request.tool_choice;
      
      // Ensure tools array is not empty
      body = ensureToolsArray(body);
      body = applyIFlowThinkingConfig(body, model, request);
      
      try {
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
          const errorText = await response.text();
          const statusCode = response.status;
          errors.push({ accountId, statusCode, message: errorText });
          
          // Handle 429 - wait 1s then try next credential
          if (statusCode === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '1', 10);
            logWarn(`[iFlow] 凭证 [${accountId}] 触发限流 (429)，冷却 ${retryAfter}s`);
            reportRateLimit(accountId, retryAfter);
            
            // Wait 1s before retry
            await new Promise(r => setTimeout(r, 1000));
            
            const nextCred = await acquireCredential({ requireProject: false, provider: 'iflow' });
            if (nextCred && `${nextCred.account_id}:iflow` !== credKey) {
              cred = nextCred;
              continue;
            }
            break;
          }
          
          // Other errors - try next credential
          logWarn(`[iFlow] 凭证 [${accountId}] 返回 ${statusCode}，切换下一个凭证...`);
          const nextCred = await acquireCredential({ requireProject: false, provider: 'iflow' });
          if (nextCred && `${nextCred.account_id}:iflow` !== credKey) {
            cred = nextCred;
            continue;
          }
          break;
        }
        
        if (!response.body) {
          throw new Error('iFlow 流式响应无数据');
        }
        
        // iFlow returns standard OpenAI SSE format, passthrough
        async function* parseStream(): AsyncIterable<any> {
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let hasUsage = false;
          let completionTokens = 0;
          
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
                if (jsonStr === '[DONE]') {
                  // If no usage was received, yield an estimated usage chunk
                  if (!hasUsage) {
                    yield {
                      id: `chatcmpl-${Date.now()}`,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model,
                      usage: {
                        prompt_tokens: estimatedTokens,
                        completion_tokens: completionTokens,
                        total_tokens: estimatedTokens + completionTokens,
                        estimated: true,
                      },
                    };
                  }
                  return;
                }
                
                try {
                  const chunk = JSON.parse(jsonStr);
                  
                  // Track if we received usage from upstream
                  if (chunk.usage) {
                    hasUsage = true;
                  }
                  
                  // Track completion tokens for estimation
                  if (chunk.choices?.[0]?.delta?.content) {
                    completionTokens += Math.ceil(chunk.choices[0].delta.content.length / 4);
                  }
                  
                  yield chunk;
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
      } catch (error: any) {
        const errorMessage = formatErrorMessage(error);
        errors.push({ accountId, statusCode: 0, message: errorMessage });
        logWarn(`[iFlow] 凭证 [${accountId}] 请求错误: ${errorMessage}，切换下一个凭证...`);
        
        const nextCred = await acquireCredential({ requireProject: false, provider: 'iflow' });
        if (nextCred && `${nextCred.account_id}:iflow` !== credKey) {
          cred = nextCred;
          continue;
        }
        break;
      }
    }
    
    // All credentials exhausted
    const errorSummary = errors.map(e => `[${e.accountId}] ${e.statusCode}: ${e.message}`).join('\n');
    throw new Error(`[iFlow] 所有 ${totalCredentials} 个凭证均请求失败。错误汇总: ${errorSummary || '未知错误'}`);
  }

  async countTokens(_model: string, request: any): Promise<{ input_tokens: number; total_tokens: number; estimated: boolean }> {
    const total = countRequestInputTokens(request);
    return {
      input_tokens: total,
      total_tokens: total,
      estimated: true,
    };
  }

  isModelSupported(model: string): boolean {
    const config = getConfig();
    const baseModel = getBaseModelName(model);
    return config.iflow.supportedModels.some((m: string) => baseModel.includes(m));
  }
}
