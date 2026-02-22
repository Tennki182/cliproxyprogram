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

/**
 * Convert OpenAI chat messages to Codex Responses API input format.
 */
function convertToResponsesInput(messages: any[]): any[] {
  const input: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled as instructions
    if (msg.role === 'user') {
      input.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            name: tc.function.name,
            arguments: tc.function.arguments,
            call_id: tc.id,
          });
        }
      }
      if (msg.content) {
        input.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: msg.content,
      });
    }
  }
  return input;
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
    const input = convertToResponsesInput(request.messages || []);

    // Codex API 强制要求 stream: true，非流式场景需要读完整个流后拼出完整响应
    const body: any = {
      model,
      stream: true,
      input,
      instructions: systemMsg?.content ?? '',
      store: false,
      parallel_tool_calls: true,
      tool_choice: 'auto',
    };
    
    // Add tools if provided
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
        .filter((t: any) => t.type === 'function')
        .map((t: any) => ({
          type: 'function',
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters || { type: 'object', properties: {} },
          strict: false,
        }));
      if (body.tools.length === 0) {
        delete body.tools;
        delete body.tool_choice;
      }
    } else {
      delete body.tool_choice;
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
          } catch { /* skip */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!completedData) {
      throw new Error('Codex 流未返回 response.completed 事件');
    }

    return this.responsesApiToOpenAI(model, completedData);
  }

  async chatCompletionStream(model: string, request: any): Promise<AsyncIterable<any>> {
    const cred = await acquireCredential({ requireProject: false, provider: 'codex' });
    if (!cred) {
      throw new Error('未登录 Codex，请先通过 /auth/codex/login 认证');
    }

    const codexConfig = getCodexOAuthConfig();
    const systemMsg = request.messages?.find((m: any) => m.role === 'system');
    const input = convertToResponsesInput(request.messages || []);

    const body: any = {
      model,
      stream: true,
      input,
      instructions: systemMsg?.content ?? '',
      store: false,
      parallel_tool_calls: true,
      tool_choice: 'auto',
    };
    
    // Add tools if provided
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
        .filter((t: any) => t.type === 'function')
        .map((t: any) => ({
          type: 'function',
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters || { type: 'object', properties: {} },
          strict: false,
        }));
      if (body.tools.length === 0) {
        delete body.tools;
        delete body.tool_choice;
      }
    } else {
      delete body.tool_choice;
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
              if (currentEvent === 'response.output_text.delta' || event.type === 'response.output_text.delta') {
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
              } else if (currentEvent === 'response.completed' || currentEvent === 'response.done' || event.type === 'response.completed' || event.type === 'response.done') {
                yield {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: timestamp,
                  model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
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
  private responsesApiToOpenAI(model: string, data: any): any {
    const choice: any = {
      index: 0,
      message: { role: 'assistant', content: '' },
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
          toolCalls.push({
            id: item.call_id || `call_${Date.now()}`,
            type: 'function',
            function: {
              name: item.name,
              arguments: item.arguments || '{}',
            },
          });
        }
      }

      if (toolCalls.length > 0) {
        choice.message.content = null;
        choice.message.tool_calls = toolCalls;
        choice.finish_reason = 'tool_calls';
      } else {
        choice.message.content = texts.join('');
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
