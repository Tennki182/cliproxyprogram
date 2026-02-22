import { Provider } from '../provider.js';
import { pfetch } from '../http.js';
import { acquireCredential, reportRateLimit } from '../rotation.js';
import { getCodexOAuthConfig, getConfig } from '../../config.js';

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

export class CodexProvider implements Provider {
  readonly name = 'codex';

  async chatCompletion(model: string, request: any): Promise<any> {
    const cred = await acquireCredential({ requireProject: false, provider: 'codex' });
    if (!cred) {
      throw new Error('未登录 Codex，请先通过 /auth/codex/login 认证');
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
    const body: any = {
      model,
      stream: true,
      input,
      instructions: systemMsg?.content ?? '',
      store: false,
      parallel_tool_calls: true,
      reasoning: {
        effort: request.reasoning_effort || 'medium',
        summary: 'auto',
      },
      include: ['reasoning.encrypted_content'],
    };
    
    // Add tools if provided (with shortened names)
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
        .filter((t: any) => t.type === 'function')
        .map((t: any) => {
          const shortName = shortNameMap.get(t.function.name) || t.function.name;
          return {
            type: 'function',
            name: shortName,
            description: t.function.description || '',
            parameters: t.function.parameters || { type: 'object', properties: {} },
            strict: false,
          };
        });
      
      body.tool_choice = processToolChoice(request.tool_choice, shortNameMap);
      
      if (body.tools.length === 0) {
        delete body.tools;
        delete body.tool_choice;
      }
    }

    const response = await pfetch(`${codexConfig.apiBase}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cred.access_token}`,
        'User-Agent': 'codex_cli_rs/0.101.0',
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
      throw new Error(`Codex API 错误 (${response.status}): ${errorText}`);
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

    return this.responsesApiToOpenAI(model, completedData, reverseMap, reasoningText);
  }

  async chatCompletionStream(model: string, request: any): Promise<AsyncIterable<any>> {
    const cred = await acquireCredential({ requireProject: false, provider: 'codex' });
    if (!cred) {
      throw new Error('未登录 Codex，请先通过 /auth/codex/login 认证');
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

    const body: any = {
      model,
      stream: true,
      input,
      instructions: systemMsg?.content ?? '',
      store: false,
      parallel_tool_calls: true,
      reasoning: {
        effort: request.reasoning_effort || 'medium',
        summary: 'auto',
      },
      include: ['reasoning.encrypted_content'],
    };
    
    // Add tools if provided (with shortened names)
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
        .filter((t: any) => t.type === 'function')
        .map((t: any) => {
          const shortName = shortNameMap.get(t.function.name) || t.function.name;
          return {
            type: 'function',
            name: shortName,
            description: t.function.description || '',
            parameters: t.function.parameters || { type: 'object', properties: {} },
            strict: false,
          };
        });
      
      body.tool_choice = processToolChoice(request.tool_choice, shortNameMap);
      
      if (body.tools.length === 0) {
        delete body.tools;
        delete body.tool_choice;
      }
    }

    const response = await pfetch(`${codexConfig.apiBase}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cred.access_token}`,
        'User-Agent': 'codex_cli_rs/0.101.0',
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
      throw new Error(`Codex API 错误 (${response.status}): ${errorText}`);
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
      // tool call index tracking removed
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
  }

  isModelSupported(model: string): boolean {
    const config = getConfig();
    return config.codex.supportedModels.some((m: string) => model.includes(m));
  }

  /**
   * Convert Responses API format to OpenAI chat completions format.
   */
  private responsesApiToOpenAI(
    model: string, 
    data: any, 
    reverseNameMap?: Map<string, string>,
    reasoningText?: string
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

    return {
      id: data.id || generateId(),
      object: 'chat.completion',
      created: getTimestamp(),
      model,
      choices: [choice],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
      system_fingerprint: `fp_${model.replace(/[^a-z0-9]/g, '_')}`,
    };
  }
}
