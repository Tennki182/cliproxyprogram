import {
  GeminiContent,
  GeminiGenerationConfig,
  GeminiTool,
  GeminiToolConfig,
  GeminiSystemInstruction,
} from '../types/gemini.js';
import { Backend } from './backend.js';
import { getConfig } from '../config.js';
import { pfetch } from './http.js';
import { acquireCredential, reportRateLimit } from './rotation.js';

const PUBLIC_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];

/**
 * Resolve auth for the public Gemini API.
 * Prefers config.gemini.apiKey; falls back to OAuth credential access_token.
 */
async function getAuth(): Promise<{ headers: Record<string, string>; queryParams: string; accountId: string }> {
  const config = getConfig();
  const apiKey = config.gemini.apiKey;

  if (apiKey) {
    return {
      headers: { 'Content-Type': 'application/json' },
      queryParams: `?key=${apiKey}`,
      accountId: '__apikey__',
    };
  }

  // Fall back to OAuth
  const credential = await acquireCredential({ requireProject: false });
  if (!credential) {
    throw new Error('未登录且未配置 apiKey，请先通过 /auth/login 认证或在 config.yaml 设置 gemini.apiKey');
  }
  return {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${credential.access_token}`,
    },
    queryParams: '',
    accountId: credential.account_id,
  };
}

function buildPublicBody(
  contents: GeminiContent[],
  systemInstruction?: GeminiSystemInstruction,
  generationConfig?: GeminiGenerationConfig,
  tools?: GeminiTool[],
  toolConfig?: GeminiToolConfig,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents,
    safetySettings: PUBLIC_SAFETY_SETTINGS,
  };

  if (generationConfig) {
    // Normalize generation config: force optimal defaults
    const normalizedConfig = { ...generationConfig };
    // Force maxOutputTokens to 64000 only if not set or too small
    if (!normalizedConfig.maxOutputTokens || normalizedConfig.maxOutputTokens < 1000) {
      normalizedConfig.maxOutputTokens = 64000;
    }
    // Force topK to 64 for better diversity
    normalizedConfig.topK = 64;
    body.generationConfig = normalizedConfig;
  } else {
    // Add default generation config with optimal settings
    body.generationConfig = {
      maxOutputTokens: 64000,
      topK: 64,
    };
  }
  if (tools && tools.length > 0) body.tools = tools;
  if (toolConfig) body.toolConfig = toolConfig;
  if (systemInstruction) body.systemInstruction = systemInstruction;

  return body;
}

function getPublicBaseUrl(): string {
  return 'https://generativelanguage.googleapis.com/v1beta';
}

export class PublicGeminiBackend implements Backend {
  readonly needsThoughtSignature = false;

  async generateContent(
    modelName: string,
    contents: GeminiContent[],
    systemInstruction?: GeminiSystemInstruction,
    generationConfig?: GeminiGenerationConfig,
    tools?: GeminiTool[],
    toolConfig?: GeminiToolConfig,
  ): Promise<any> {
    const { headers, queryParams, accountId } = await getAuth();
    const url = `${getPublicBaseUrl()}/models/${modelName}:generateContent${queryParams}`;
    const body = buildPublicBody(contents, systemInstruction, generationConfig, tools, toolConfig);

    const response = await pfetch(url, {
      method: 'POST',
      headers: { ...headers, 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
        reportRateLimit(accountId, retryAfter);
      }
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.error?.status || errorText;
      } catch {
        errorMessage = errorText;
      }
      throw new Error(`Gemini Public API 错误 (${response.status}): ${errorMessage}`);
    }

    return await response.json() as any;
  }

  async generateContentStream(
    modelName: string,
    contents: GeminiContent[],
    systemInstruction?: GeminiSystemInstruction,
    generationConfig?: GeminiGenerationConfig,
    tools?: GeminiTool[],
    toolConfig?: GeminiToolConfig,
  ): Promise<AsyncIterable<any>> {
    const { headers, queryParams, accountId } = await getAuth();
    const url = `${getPublicBaseUrl()}/models/${modelName}:streamGenerateContent?alt=sse${queryParams ? '&' + queryParams.slice(1) : ''}`;
    const body = buildPublicBody(contents, systemInstruction, generationConfig, tools, toolConfig);

    const response = await pfetch(url, {
      method: 'POST',
      headers: { ...headers, 'Accept': 'text/event-stream' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
        reportRateLimit(accountId, retryAfter);
      }
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.error?.status || errorText;
      } catch {
        errorMessage = errorText;
      }
      throw new Error(`Gemini Public API 错误 (${response.status}): ${errorMessage}`);
    }

    if (!response.body) {
      throw new Error('流式响应无数据');
    }

    async function* parseSSEStream(): AsyncIterable<any> {
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
            if (trimmed.startsWith('data: ')) {
              const jsonStr = trimmed.slice(6);
              if (jsonStr === '[DONE]') return;
              try {
                yield JSON.parse(jsonStr);
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }

        if (buffer.trim().startsWith('data: ')) {
          const jsonStr = buffer.trim().slice(6);
          if (jsonStr && jsonStr !== '[DONE]') {
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

    return parseSSEStream();
  }

  isModelSupported(modelName: string): boolean {
    const config = getConfig();
    return config.gemini.supportedModels.some((m) => modelName.includes(m));
  }
}
