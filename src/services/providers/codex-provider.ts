import { Provider } from '../provider.js';
import { pfetch } from '../http.js';
import { acquireCredential, reportRateLimit } from '../rotation.js';
import { getCodexOAuthConfig, getConfig } from '../../config.js';
import { listCredentials } from '../../storage/credentials.js';
import { randomUUID } from 'crypto';
import { countMessagesTokens, countRequestInputTokens, estimateTokens } from '../token-counter.js';
import { getBaseModelName, getThinkingSettingsFromModel } from '../converter.js';
import { formatErrorMessage, logWarn } from '../log-stream.js';

// Codex cache for prompt_cache_key
interface CodexCache {
  id: string;
  expire: number;
}
const codexCacheMap = new Map<string, CodexCache>();

function getCodexCache(key: string): CodexCache | undefined {
  const cache = codexCacheMap.get(key);
  if (!cache) return undefined;
  if (Date.now() > cache.expire) {
    codexCacheMap.delete(key);
    return undefined;
  }
  return cache;
}

function setCodexCache(key: string, cache: CodexCache): void {
  codexCacheMap.set(key, cache);
}

function generateId(): string {
  return 'chatcmpl-' + Math.random().toString(36).substring(2, 15);
}

function getTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

const TOOL_NAME_LIMIT = 64;

/**
 * Shorten tool name if needed (Codex has 64 char limit)
 * Preserves mcp__ prefix and last segment if possible
 */
function shortenToolName(name: string): string {
  if (name.length <= TOOL_NAME_LIMIT) return name;
  
  // Try to preserve mcp__ prefix and last segment
  if (name.startsWith('mcp__')) {
    const lastDoubleUnderscore = name.lastIndexOf('__');
    if (lastDoubleUnderscore > 0) {
      const candidate = 'mcp__' + name.substring(lastDoubleUnderscore + 2);
      if (candidate.length <= TOOL_NAME_LIMIT) return candidate;
      return candidate.substring(0, TOOL_NAME_LIMIT);
    }
  }
  
  return name.substring(0, TOOL_NAME_LIMIT);
}

/**
 * Build short name map ensuring uniqueness
 */
function buildShortNameMap(originalNames: string[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  
  for (const name of originalNames) {
    let candidate = shortenToolName(name);
    let finalName = candidate;
    let counter = 1;
    
    // Ensure uniqueness
    while (used.has(finalName)) {
      const suffix = '_' + counter;
      const allowed = TOOL_NAME_LIMIT - suffix.length;
      finalName = candidate.substring(0, Math.max(0, allowed)) + suffix;
      counter++;
    }
    
    used.add(finalName);
    map.set(name, finalName);
  }
  
  return map;
}

/**
 * Convert OpenAI chat messages to Codex Responses API input format.
 * Handles tool name shortening and multimodal content.
 */
function convertToResponsesInput(messages: any[], shortNameMap: Map<string, string>): any[] {
  const input: any[] = [];
  
  // Track call IDs for pairing function calls with outputs
  const pendingCallIds: string[] = [];
  
  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled as instructions
    
    if (msg.role === 'user') {
      // Handle multimodal content
      if (Array.isArray(msg.content)) {
        const content: any[] = [];
        for (const item of msg.content) {
          if (item.type === 'text') {
            content.push({ type: 'input_text', text: item.text });
          } else if (item.type === 'image_url') {
            // Codex doesn't support images directly, skip or convert to text reference
            content.push({ type: 'input_text', text: '[Image]' });
          }
        }
        if (content.length > 0) {
          input.push({ role: 'user', content });
        }
      } else {
        input.push({ role: 'user', content: msg.content });
      }
    } else if (msg.role === 'assistant') {
      // Handle tool calls first (they come before content in Responses API)
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const shortName = shortNameMap.get(tc.function.name) || tc.function.name;
          const callId = tc.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          pendingCallIds.push(callId);
          input.push({
            type: 'function_call',
            name: shortName,
            arguments: tc.function.arguments,
            call_id: callId,
          });
        }
      }
      
      // Then add text content
      if (msg.content) {
        input.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool') {
      // Pair with the earliest pending call ID
      const callId = pendingCallIds.length > 0 
        ? pendingCallIds.shift() 
        : msg.tool_call_id || `call_${Date.now()}`;
      
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: msg.content,
      });
    }
  }
  
  return input;
}

/**
 * Process tool_choice with name shortening
 */
function processToolChoice(toolChoice: any, shortNameMap: Map<string, string>): any {
  if (!toolChoice) return 'auto';
  
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }
  
  if (toolChoice.type === 'function' && toolChoice.function?.name) {
    const shortName = shortNameMap.get(toolChoice.function.name) || toolChoice.function.name;
    return {
      type: 'function',
      name: shortName,
    };
  }
  
  return toolChoice;
}

function buildCodexTools(tools: any[] | undefined, shortNameMap: Map<string, string>): any[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  return tools.flatMap((tool: any) => {
    if (tool.type === 'function' && tool.function?.name) {
      const shortName = shortNameMap.get(tool.function.name) || tool.function.name;
      return [{
        type: 'function',
        name: shortName,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
        strict: false,
      }];
    }

    if (typeof tool?.type === 'string') {
      return [{ ...tool }];
    }

    return [];
  });
}

function mapThinkingSettingsToCodexEffort(model: string): 'low' | 'medium' | 'high' | 'auto' | 'none' | undefined {
  const thinkingSettings = getThinkingSettingsFromModel(model);
  if (!thinkingSettings) {
    return undefined;
  }

  if (thinkingSettings.thinkingLevel) {
    switch (thinkingSettings.thinkingLevel) {
      case 'none':
        return 'none';
      case 'minimal':
      case 'low':
        return 'low';
      case 'medium':
        return 'medium';
      case 'high':
      case 'xhigh':
        return 'high';
      default:
        return undefined;
    }
  }

  if (thinkingSettings.thinkingBudget !== undefined) {
    if (thinkingSettings.thinkingBudget === 0) {
      return 'none';
    }
    if (thinkingSettings.thinkingBudget < 0) {
      return 'auto';
    }
    if (thinkingSettings.thinkingBudget <= 1024) {
      return 'low';
    }
    if (thinkingSettings.thinkingBudget <= 8192) {
      return 'medium';
    }
    return 'high';
  }

  return undefined;
}

function getCodexReasoningEffort(model: string, request: any): 'low' | 'medium' | 'high' | 'auto' | 'none' {
  if (request.reasoning_effort) {
    return request.reasoning_effort;
  }

  return mapThinkingSettingsToCodexEffort(model) || 'medium';
}

export class CodexProvider implements Provider {
  readonly name = 'codex';

  private getCacheKey(request: any, model: string): string | null {
    // Only enable cache for Claude-style requests with metadata.user_id
    const userId = request.metadata?.user_id;
    if (userId) {
      return `${model}-${userId}`;
    }
    // Or for requests with explicit prompt_cache_key
    if (request.prompt_cache_key) {
      return request.prompt_cache_key;
    }
    return null;
  }

  private applyCache(body: any, cacheKey: string | null, request: any): { body: any; cacheId: string | null } {
    let cacheId: string | null = null;
    let newBody = body;
    
    if (cacheKey) {
      let cache = getCodexCache(cacheKey);
      if (!cache) {
        cache = {
          id: randomUUID(),
          expire: Date.now() + 60 * 60 * 1000, // 1 hour
        };
        setCodexCache(cacheKey, cache);
      }
      cacheId = cache.id;
      newBody = { ...body, prompt_cache_key: cacheId };
    } else if (request.prompt_cache_key) {
      // Use provided cache key directly
      cacheId = request.prompt_cache_key;
      newBody = { ...body, prompt_cache_key: cacheId };
    }
    
    return { body: newBody, cacheId };
  }

  async chatCompletion(model: string, request: any): Promise<any> {
    const actualModel = getBaseModelName(model);
    // Check for /responses/compact endpoint
    if (request.compact === true || request.stream === false) {
      return this.executeCompact(model, request);
    }

    const errors: Array<{ accountId: string; statusCode: number; message: string }> = [];
    const triedCredentials = new Set<string>();
    let attemptCount = 0;
    
    // Get all available Codex credentials
    const allCredentials = listCredentials().filter(c => c.provider === 'codex');
    const totalCredentials = allCredentials.length;
    
    if (totalCredentials === 0) {
      throw new Error('未登录 Codex，请先通过 /auth/codex/login 认证');
    }
    
    // Get initial credential
    let cred = await acquireCredential({ requireProject: false, provider: 'codex' });
    if (!cred) {
      throw new Error('未登录 Codex，请先通过 /auth/codex/login 认证');
    }
    
    // Main retry loop - try all credentials
    while (attemptCount < totalCredentials && cred) {
      const credKey = `${cred.account_id}:codex`;
      
      // Skip if already tried this credential
      if (triedCredentials.has(credKey)) {
        const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
        if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
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
        logWarn(`[Codex] 使用凭证 [${accountId}] 发起请求 (共 ${totalCredentials} 个凭证可用)`);
      } else {
        logWarn(`[Codex] 重试 #${attemptCount}: 切换到凭证 [${accountId}]`);
      }
      
      const codexConfig = getCodexOAuthConfig();
      const systemMsg = request.messages?.find((m: any) => m.role === 'system');
      
      // Build tool name shortening map
      const originalToolNames: string[] = [];
      if (request.tools) {
        for (const t of request.tools) {
          if (t.type === 'function' && t.function?.name) {
            originalToolNames.push(t.function.name);
          }
        }
      }
      const shortNameMap = buildShortNameMap(originalToolNames);
      const reverseMap = new Map([...shortNameMap].map(([k, v]) => [v, k]));
      
      const input = convertToResponsesInput(request.messages || [], shortNameMap);

      // Codex API 强制要求 stream: true
      let body: any = {
        model: actualModel,
        stream: true,
        input,
        instructions: systemMsg?.content ?? '',
        store: false,
        parallel_tool_calls: true,
        reasoning: {
          effort: getCodexReasoningEffort(model, request),
          summary: 'auto',
        },
        include: ['reasoning.encrypted_content'],
      };
      
      // Add tools if provided (with shortened names)
      if (request.tools && request.tools.length > 0) {
        body.tools = buildCodexTools(request.tools, shortNameMap);
        
        body.tool_choice = processToolChoice(request.tool_choice, shortNameMap);
        
        if (body.tools.length === 0) {
          delete body.tools;
          delete body.tool_choice;
        }
      }

      // Apply cache
      const cacheKey = this.getCacheKey(request, actualModel);
      const { body: finalBody, cacheId } = this.applyCache(body, cacheKey, request);
      body = finalBody;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cred.access_token}`,
        'User-Agent': 'codex_cli_rs/0.101.0',
        'Accept': 'text/event-stream',
      };
      
      if (cacheId) {
        headers['Conversation_id'] = cacheId;
        headers['Session_id'] = cacheId;
      }

      try {
        const response = await pfetch(`${codexConfig.apiBase}/responses`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }, { proxyUrl: cred.proxy_url || undefined });

        if (!response.ok) {
          const errorText = await response.text();
          const statusCode = response.status;
          errors.push({ accountId, statusCode, message: errorText });
          
          // Handle 429 - wait 1s then try next credential
          if (statusCode === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '1', 10);
            logWarn(`[Codex] 凭证 [${accountId}] 触发限流 (429)，冷却 ${retryAfter}s`);
            reportRateLimit(accountId, retryAfter);
            
            // Wait 1s before retry
            await new Promise(r => setTimeout(r, 1000));
            
            const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
            if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
              cred = nextCred;
              continue;
            }
            break;
          }
          
          // Other errors - try next credential
          logWarn(`[Codex] 凭证 [${accountId}] 返回 ${statusCode}，切换下一个凭证...`);
          const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
          if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
            cred = nextCred;
            continue;
          }
          break;
        }

        if (!response.body) {
          throw new Error('Codex 流式响应无数据');
        }

        // 读完整个 SSE 流，从 response.completed 事件提取完整响应
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let completedData: any = null;
        let reasoningText = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('event: ')) {
                currentEvent = trimmed.slice(7);
                continue;
              }
              if (!trimmed.startsWith('data: ')) continue;
              const jsonStr = trimmed.slice(6);
              if (jsonStr === '[DONE]') break;
              try {
                const event = JSON.parse(jsonStr);
                if (currentEvent === 'response.completed' || event.type === 'response.completed') {
                  completedData = event.response || event;
                }
                // Collect reasoning text
                if (currentEvent === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_summary_text.delta') {
                  reasoningText += event.delta || '';
                }
              } catch { /* skip */ }
            }
          }
        } finally {
          reader.releaseLock();
        }

        if (!completedData) {
          throw new Error('Codex 流未返回 response.completed 事件');
        }

        return this.responsesApiToOpenAI(model, completedData, reverseMap, reasoningText, request);
      } catch (error: any) {
        // If it's already a thrown error from our logic, check if we should continue
        if (error.message?.includes('[Codex] 所有') || error.message?.includes('切换下一个凭证')) {
          throw error;
        }
        
        const errorMessage = formatErrorMessage(error);
        errors.push({ accountId, statusCode: 0, message: errorMessage });
        logWarn(`[Codex] 凭证 [${accountId}] 请求错误: ${errorMessage}，切换下一个凭证...`);
        
        const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
        if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
          cred = nextCred;
          continue;
        }
        break;
      }
    }
    
    // All credentials exhausted
    const errorSummary = errors.map(e => `[${e.accountId}] ${e.statusCode}: ${e.message}`).join('\n');
    throw new Error(`[Codex] 所有 ${totalCredentials} 个凭证均请求失败。错误汇总: ${errorSummary || '未知错误'}`);
  }

  async chatCompletionStream(model: string, request: any): Promise<AsyncIterable<any>> {
    const actualModel = getBaseModelName(model);
    const errors: Array<{ accountId: string; statusCode: number; message: string }> = [];
    const triedCredentials = new Set<string>();
    let attemptCount = 0;
    
    // Get all available Codex credentials
    const allCredentials = listCredentials().filter(c => c.provider === 'codex');
    const totalCredentials = allCredentials.length;
    
    if (totalCredentials === 0) {
      throw new Error('未登录 Codex，请先通过 /auth/codex/login 认证');
    }
    
    // Get initial credential
    let cred = await acquireCredential({ requireProject: false, provider: 'codex' });
    if (!cred) {
      throw new Error('未登录 Codex，请先通过 /auth/codex/login 认证');
    }
    
    // Main retry loop - try all credentials
    while (attemptCount < totalCredentials && cred) {
      const credKey = `${cred.account_id}:codex`;
      
      // Skip if already tried this credential
      if (triedCredentials.has(credKey)) {
        const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
        if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
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
        logWarn(`[Codex] 使用凭证 [${accountId}] 发起流式请求 (共 ${totalCredentials} 个凭证可用)`);
      } else {
        logWarn(`[Codex] 重试 #${attemptCount}: 切换到凭证 [${accountId}]`);
      }
      
      const codexConfig = getCodexOAuthConfig();
      const systemMsg = request.messages?.find((m: any) => m.role === 'system');
      
      // Build tool name shortening map
      const originalToolNames: string[] = [];
      if (request.tools) {
        for (const t of request.tools) {
          if (t.type === 'function' && t.function?.name) {
            originalToolNames.push(t.function.name);
          }
        }
      }
      const shortNameMap = buildShortNameMap(originalToolNames);
      const reverseMap = new Map([...shortNameMap].map(([k, v]) => [v, k]));
      
      const input = convertToResponsesInput(request.messages || [], shortNameMap);

      let body: any = {
        model: actualModel,
        stream: true,
        input,
        instructions: systemMsg?.content ?? '',
        store: false,
        parallel_tool_calls: true,
        reasoning: {
          effort: getCodexReasoningEffort(model, request),
          summary: 'auto',
        },
        include: ['reasoning.encrypted_content'],
      };
      
      // Add tools if provided (with shortened names)
      if (request.tools && request.tools.length > 0) {
        body.tools = buildCodexTools(request.tools, shortNameMap);
        
        body.tool_choice = processToolChoice(request.tool_choice, shortNameMap);
        
        if (body.tools.length === 0) {
          delete body.tools;
          delete body.tool_choice;
        }
      }

      // Apply cache
      const cacheKey = this.getCacheKey(request, actualModel);
      const { body: finalBody, cacheId } = this.applyCache(body, cacheKey, request);
      body = finalBody;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cred.access_token}`,
        'User-Agent': 'codex_cli_rs/0.101.0',
        'Accept': 'text/event-stream',
      };
      
      if (cacheId) {
        headers['Conversation_id'] = cacheId;
        headers['Session_id'] = cacheId;
      }

      try {
        const response = await pfetch(`${codexConfig.apiBase}/responses`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }, { proxyUrl: cred.proxy_url || undefined });

        if (!response.ok) {
          const errorText = await response.text();
          const statusCode = response.status;
          errors.push({ accountId, statusCode, message: errorText });
          
          // Handle 429 - wait 1s then try next credential
          if (statusCode === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '1', 10);
            logWarn(`[Codex] 凭证 [${accountId}] 触发限流 (429)，冷却 ${retryAfter}s`);
            reportRateLimit(accountId, retryAfter);
            
            // Wait 1s before retry
            await new Promise(r => setTimeout(r, 1000));
            
            const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
            if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
              cred = nextCred;
              continue;
            }
            break;
          }
          
          // Other errors - try next credential
          logWarn(`[Codex] 凭证 [${accountId}] 返回 ${statusCode}，切换下一个凭证...`);
          const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
          if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
            cred = nextCred;
            continue;
          }
          break;
        }

        if (!response.body) {
          throw new Error('Codex 流式响应无数据');
        }

        const completionId = generateId();
        const timestamp = getTimestamp();

        async function* parseStream(): AsyncIterable<any> {
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let currentEvent = '';
          let hasToolCalls = false;
          const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();

                if (trimmed.startsWith('event: ')) {
                  currentEvent = trimmed.slice(7);
                  continue;
                }

                if (!trimmed.startsWith('data: ')) continue;

                const jsonStr = trimmed.slice(6);
                if (jsonStr === '[DONE]') return;

                try {
                  const event = JSON.parse(jsonStr);
                  const eventType = event.type || currentEvent;
                  
                  if (eventType === 'response.output_text.delta') {
                    const text = event.delta || '';
                    if (text) {
                      yield {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: timestamp,
                        model,
                        choices: [{
                          index: 0,
                          delta: { role: 'assistant', content: text },
                          finish_reason: null,
                        }],
                      };
                    }
                  } else if (eventType === 'response.reasoning_summary_text.delta') {
                    // Yield reasoning content
                    const text = event.delta || '';
                    if (text) {
                      yield {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: timestamp,
                        model,
                        choices: [{
                          index: 0,
                          delta: { role: 'assistant', reasoning_content: text },
                          finish_reason: null,
                        }],
                      };
                    }
                  } else if (eventType === 'response.function_call_arguments.delta') {
                    // Handle function call arguments streaming
                    hasToolCalls = true;
                    const tcIndex = event.item_index || 0;
                    
                    if (!toolCallBuffers.has(tcIndex)) {
                      toolCallBuffers.set(tcIndex, {
                        id: event.call_id || `call_${Date.now()}_${tcIndex}`,
                        name: reverseMap.get(event.name) || event.name || '',
                        args: '',
                      });
                      
                      // Start new tool call
                      yield {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: timestamp,
                        model,
                        choices: [{
                          index: 0,
                          delta: {
                            role: 'assistant',
                            tool_calls: [{
                              index: tcIndex,
                              id: toolCallBuffers.get(tcIndex)!.id,
                              type: 'function',
                              function: {
                                name: toolCallBuffers.get(tcIndex)!.name,
                                arguments: '',
                              },
                            }],
                          },
                          finish_reason: null,
                        }],
                      };
                    }
                    
                    // Append arguments
                    const buf = toolCallBuffers.get(tcIndex)!;
                    if (event.delta) {
                      buf.args += event.delta;
                      yield {
                        id: completionId,
                        object: 'chat.completion.chunk',
                        created: timestamp,
                        model,
                        choices: [{
                          index: 0,
                          delta: {
                            tool_calls: [{
                              index: tcIndex,
                              function: {
                                arguments: event.delta,
                              },
                            }],
                          },
                          finish_reason: null,
                        }],
                      };
                    }
                  } else if (eventType === 'response.output_item.done') {
                    // Function call completed
                    if (event.item?.type === 'function_call') {
                      hasToolCalls = true;
                    }
                  } else if (eventType === 'response.completed' || eventType === 'response.done') {
                    yield {
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: timestamp,
                      model,
                      choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
                      }],
                    };
                  }
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
        // If it's already a thrown error from our logic, check if we should continue
        if (error.message?.includes('[Codex] 所有') || error.message?.includes('切换下一个凭证')) {
          throw error;
        }
        
        const errorMessage = formatErrorMessage(error);
        errors.push({ accountId, statusCode: 0, message: errorMessage });
        logWarn(`[Codex] 凭证 [${accountId}] 请求错误: ${errorMessage}，切换下一个凭证...`);
        
        const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
        if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
          cred = nextCred;
          continue;
        }
        break;
      }
    }
    
    // All credentials exhausted
    const errorSummary = errors.map(e => `[${e.accountId}] ${e.statusCode}: ${e.message}`).join('\n');
    throw new Error(`[Codex] 所有 ${totalCredentials} 个凭证均请求失败。错误汇总: ${errorSummary || '未知错误'}`);
  }

  /**
   * Execute compact request (non-streaming, for /responses/compact)
   */
  private async executeCompact(model: string, request: any): Promise<any> {
    const actualModel = getBaseModelName(model);
    const errors: Array<{ accountId: string; statusCode: number; message: string }> = [];
    const triedCredentials = new Set<string>();
    let attemptCount = 0;
    
    // Get all available Codex credentials
    const allCredentials = listCredentials().filter(c => c.provider === 'codex');
    const totalCredentials = allCredentials.length;
    
    if (totalCredentials === 0) {
      throw new Error('未登录 Codex，请先通过 /auth/codex/login 认证');
    }
    
    // Get initial credential
    let cred = await acquireCredential({ requireProject: false, provider: 'codex' });
    if (!cred) {
      throw new Error('未登录 Codex，请先通过 /auth/codex/login 认证');
    }
    
    // Main retry loop - try all credentials
    while (attemptCount < totalCredentials && cred) {
      const credKey = `${cred.account_id}:codex`;
      
      // Skip if already tried this credential
      if (triedCredentials.has(credKey)) {
        const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
        if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
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
        logWarn(`[Codex] 使用凭证 [${accountId}] 发起 compact 请求 (共 ${totalCredentials} 个凭证可用)`);
      } else {
        logWarn(`[Codex] 重试 #${attemptCount}: 切换到凭证 [${accountId}]`);
      }
      
      const codexConfig = getCodexOAuthConfig();
      
      // Build tool name shortening map
      const originalToolNames: string[] = [];
      if (request.tools) {
        for (const t of request.tools) {
          if (t.type === 'function' && t.function?.name) {
            originalToolNames.push(t.function.name);
          }
        }
      }
      const shortNameMap = buildShortNameMap(originalToolNames);
      const reverseMap = new Map([...shortNameMap].map(([k, v]) => [v, k]));
      
      const input = convertToResponsesInput(request.messages || [], shortNameMap);

      let body: any = {
        model: actualModel,
        input,
        instructions: request.messages?.find((m: any) => m.role === 'system')?.content ?? '',
        store: false,
        parallel_tool_calls: true,
        reasoning: {
          effort: getCodexReasoningEffort(model, request),
          summary: 'auto',
        },
      };
      
      // Add tools if provided
      if (request.tools && request.tools.length > 0) {
        body.tools = buildCodexTools(request.tools, shortNameMap);
        
        body.tool_choice = processToolChoice(request.tool_choice, shortNameMap);
        
        if (body.tools.length === 0) {
          delete body.tools;
          delete body.tool_choice;
        }
      }

      // Apply cache
      const cacheKey = this.getCacheKey(request, actualModel);
      const { body: finalBody, cacheId } = this.applyCache(body, cacheKey, request);
      body = finalBody;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cred.access_token}`,
        'User-Agent': 'codex_cli_rs/0.101.0',
        'Accept': 'application/json',
      };
      
      if (cacheId) {
        headers['Conversation_id'] = cacheId;
        headers['Session_id'] = cacheId;
      }

      try {
        const response = await pfetch(`${codexConfig.apiBase}/responses/compact`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }, { proxyUrl: cred.proxy_url || undefined });

        if (!response.ok) {
          const errorText = await response.text();
          const statusCode = response.status;
          errors.push({ accountId, statusCode, message: errorText });
          
          // Handle 429 - wait 1s then try next credential
          if (statusCode === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '1', 10);
            logWarn(`[Codex] 凭证 [${accountId}] 触发限流 (429)，冷却 ${retryAfter}s`);
            reportRateLimit(accountId, retryAfter);
            
            // Wait 1s before retry
            await new Promise(r => setTimeout(r, 1000));
            
            const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
            if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
              cred = nextCred;
              continue;
            }
            break;
          }
          
          // Other errors - try next credential
          logWarn(`[Codex] 凭证 [${accountId}] 返回 ${statusCode}，切换下一个凭证...`);
          const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
          if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
            cred = nextCred;
            continue;
          }
          break;
        }

        const data = await response.json();
        return this.responsesApiToOpenAI(model, data, reverseMap, undefined, request);
      } catch (error: any) {
        const errorMessage = formatErrorMessage(error);
        errors.push({ accountId, statusCode: 0, message: errorMessage });
        logWarn(`[Codex] 凭证 [${accountId}] 请求错误: ${errorMessage}，切换下一个凭证...`);
        
        const nextCred = await acquireCredential({ requireProject: false, provider: 'codex' });
        if (nextCred && `${nextCred.account_id}:codex` !== credKey) {
          cred = nextCred;
          continue;
        }
        break;
      }
    }
    
    // All credentials exhausted
    const errorSummary = errors.map(e => `[${e.accountId}] ${e.statusCode}: ${e.message}`).join('\n');
    throw new Error(`[Codex] 所有 ${totalCredentials} 个凭证均请求失败。错误汇总: ${errorSummary || '未知错误'}`);
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
    return config.codex.supportedModels.some((m: string) => baseModel.includes(m));
  }

  /**
   * Convert Responses API format to OpenAI chat completions format.
   */
  private responsesApiToOpenAI(
    model: string, 
    data: any, 
    reverseNameMap?: Map<string, string>,
    reasoningText?: string,
    originalRequest?: any
  ): any {
    const choice: any = {
      index: 0,
      message: { 
        role: 'assistant', 
        content: '',
        reasoning_content: reasoningText || null,
      },
      finish_reason: 'stop',
    };

    // Responses API returns output items
    if (data.output) {
      const texts: string[] = [];
      const toolCalls: any[] = [];

      for (const item of data.output) {
        if (item.type === 'message' && item.content) {
          for (const c of item.content) {
            if (c.type === 'output_text') texts.push(c.text);
          }
        } else if (item.type === 'function_call') {
          // Restore original tool name
          const originalName = reverseNameMap?.get(item.name) || item.name;
          toolCalls.push({
            id: item.call_id || `call_${Date.now()}`,
            type: 'function',
            function: {
              name: originalName,
              arguments: item.arguments || '{}',
            },
          });
        } else if (item.type === 'reasoning' && item.content) {
          // Add reasoning content
          choice.message.reasoning_content = item.content;
        }
      }

      if (toolCalls.length > 0) {
        choice.message.content = null;
        choice.message.tool_calls = toolCalls;
        choice.finish_reason = 'tool_calls';
      } else {
        choice.message.content = texts.join('') || null;
      }
    }

    // Calculate usage - prefer API returned values, fallback to estimation
    const promptTokens = data.usage?.input_tokens ?? 
      (originalRequest ? countMessagesTokens(originalRequest.messages || []) : 0);
    const completionTokens = data.usage?.output_tokens ?? 
      estimateTokens(choice.message.content || '');

    return {
      id: data.id || generateId(),
      object: 'chat.completion',
      created: getTimestamp(),
      model,
      choices: [choice],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: data.usage?.total_tokens ?? (promptTokens + completionTokens),
        ...(data.usage?.input_tokens ? {} : { estimated: true }),
      },
      system_fingerprint: `fp_${model.replace(/[^a-z0-9]/g, '_')}`,
    };
  }
}
