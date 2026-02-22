import { Provider } from '../provider.js';
import { pfetch } from '../http.js';
import {
  OpenAICompatProvider as ProviderConfig,
  getEnabledProviders,
  getEnabledModelsByProvider,
} from '../../storage/openai-compat.js';

/**
 * OpenAI-compatible provider that forwards requests to any OpenAI-compatible API.
 * Supports OpenRouter, SiliconFlow, OneAPI, and other OpenAI-compatible services.
 */
export class OpenAICompatProvider implements Provider {
  readonly name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  /**
   * Resolve alias to actual model name.
   */
  private resolveModelAlias(model: string): string {
    const models = getEnabledModelsByProvider(this.name);
    const entry = models.find(m => m.alias === model || m.modelId === model);
    return entry?.modelId || model;
  }

  /**
   * Get model alias from actual model name.
   */
  private getModelAlias(model: string): string {
    const models = getEnabledModelsByProvider(this.name);
    const entry = models.find(m => m.modelId === model);
    return entry?.alias || model;
  }

  /**
   * Build request headers with authentication and custom headers.
   */
  private buildHeaders(stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    };
    
    if (stream) {
      headers['Accept'] = 'text/event-stream';
    }
    
    return headers;
  }

  async chatCompletion(model: string, request: any): Promise<any> {
    const actualModel = this.resolveModelAlias(model);
    const baseUrl = this.config.baseUrl.replace(/\/$/, '');
    
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: false,
    };
    
    // Copy optional parameters
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.max_completion_tokens !== undefined) body.max_completion_tokens = request.max_completion_tokens;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.tools !== undefined) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.response_format !== undefined) body.response_format = request.response_format;
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.user !== undefined) body.user = request.user;

    const response = await pfetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(false),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${this.name} API 错误 (${response.status}): ${errorText}`);
    }

    const data = await response.json() as any;
    
    // Replace model name with alias in response if applicable
    if (data.model) {
      data.model = this.getModelAlias(data.model);
    }
    
    return data;
  }

  async chatCompletionStream(model: string, request: any): Promise<AsyncIterable<any>> {
    const actualModel = this.resolveModelAlias(model);
    const baseUrl = this.config.baseUrl.replace(/\/$/, '');
    
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: true,
    };
    
    // Copy optional parameters
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.max_completion_tokens !== undefined) body.max_completion_tokens = request.max_completion_tokens;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.tools !== undefined) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.response_format !== undefined) body.response_format = request.response_format;
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.user !== undefined) body.user = request.user;

    const response = await pfetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(true),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${this.name} API 错误 (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error(`${this.name} 流式响应无数据`);
    }

    const self = this;

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
              const chunk = JSON.parse(jsonStr);
              // Replace model name with alias in chunk if applicable
              if (chunk.model) {
                chunk.model = self.getModelAlias(chunk.model);
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
  }

  isModelSupported(model: string): boolean {
    const models = getEnabledModelsByProvider(this.name);
    return models.some(m => m.modelId === model || m.alias === model);
  }

  /**
   * Check if a model name matches this provider's prefix.
   */
  matchesPrefix(model: string): boolean {
    if (!this.config.prefix) return false;
    return model.startsWith(`${this.config.prefix}/`);
  }

  /**
   * Strip prefix from model name.
   */
  stripPrefix(model: string): string {
    if (!this.config.prefix) return model;
    const prefix = `${this.config.prefix}/`;
    if (model.startsWith(prefix)) {
      return model.substring(prefix.length);
    }
    return model;
  }
}

/**
 * Get all enabled OpenAI-compatible providers from database.
 */
export function getOpenAICompatProviders(): OpenAICompatProvider[] {
  const configs = getEnabledProviders();
  return configs.map(cfg => new OpenAICompatProvider(cfg));
}

/**
 * Fetch models from upstream provider's /v1/models endpoint.
 */
export async function fetchModelsFromProvider(baseUrl: string, apiKey: string, headers: Record<string, string> = {}): Promise<Array<{ id: string; owned_by?: string }>> {
  const url = baseUrl.replace(/\/$/, '') + '/models';
  
  const response = await pfetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      ...headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`获取模型列表失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json() as any;
  
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('无效的模型列表响应格式');
  }

  return data.data.map((m: any) => ({
    id: m.id,
    owned_by: m.owned_by,
  }));
}
