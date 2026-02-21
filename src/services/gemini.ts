import {
  GeminiContent,
  GeminiGenerationConfig,
  GeminiTool,
  GeminiToolConfig,
} from '../types/gemini.js';
import { getConfig } from '../config.js';
import { pfetch } from './http.js';
import { acquireCredential, reportRateLimit } from './rotation.js';

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];

const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': 'google-api-nodejs-client/9.15.1',
  'X-Goog-Api-Client': 'gl-node/22.17.0',
  'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
};

/**
 * Build the API URL for cloudcode-pa.googleapis.com/v1internal
 * Format: {base}:{method} (NOT {base}/publishers/google/models/{model}:{method})
 */
function getApiUrl(method: string): string {
  const config = getConfig();
  return `${config.gemini.apiEndpoint}:${method}`;
}

async function getCredential(): Promise<{ accessToken: string; projectId: string; accountId: string }> {
  const credential = await acquireCredential();
  if (!credential) {
    throw new Error('未登录，请先通过 /auth/login 认证');
  }
  if (!credential.project_id) {
    throw new Error('未发现 GCP 项目，请重新认证');
  }
  return {
    accessToken: credential.access_token,
    projectId: credential.project_id,
    accountId: credential.account_id,
  };
}

/**
 * Build request body in the cloudcode-pa v1internal format:
 * { model, project, request: { contents, generationConfig, ... } }
 */
function buildRequestBody(
  modelName: string,
  projectId: string,
  contents: GeminiContent[],
  systemInstruction?: GeminiContent,
  generationConfig?: GeminiGenerationConfig,
  tools?: GeminiTool[],
  toolConfig?: GeminiToolConfig
): Record<string, unknown> {
  const innerRequest: Record<string, unknown> = {
    contents,
    safetySettings: SAFETY_SETTINGS,
  };

  if (generationConfig) {
    innerRequest.generationConfig = generationConfig;
  }
  if (tools && tools.length > 0) {
    innerRequest.tools = tools;
  }
  if (toolConfig) {
    innerRequest.toolConfig = toolConfig;
  }
  if (systemInstruction) {
    innerRequest.systemInstruction = systemInstruction;
  }

  return {
    model: modelName,
    project: projectId,
    request: innerRequest,
  };
}

/**
 * Unwrap the cloudcode-pa response envelope.
 * The API returns { response: { candidates, usageMetadata, ... } }
 * We need to extract the inner response object.
 */
function unwrapResponse(data: any): any {
  if (data.response) {
    return data.response;
  }
  return data;
}

export async function generateContent(
  modelName: string,
  contents: GeminiContent[],
  systemInstruction?: GeminiContent,
  generationConfig?: GeminiGenerationConfig,
  tools?: GeminiTool[],
  toolConfig?: GeminiToolConfig
): Promise<any> {
  const { accessToken, projectId, accountId } = await getCredential();
  const url = getApiUrl('generateContent');
  const body = buildRequestBody(modelName, projectId, contents, systemInstruction, generationConfig, tools, toolConfig);

  const response = await pfetch(url, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
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
    throw new Error(`Gemini API 错误 (${response.status}): ${errorMessage}`);
  }

  const data = await response.json() as any;
  return unwrapResponse(data);
}

export async function generateContentStream(
  modelName: string,
  contents: GeminiContent[],
  systemInstruction?: GeminiContent,
  generationConfig?: GeminiGenerationConfig,
  tools?: GeminiTool[],
  toolConfig?: GeminiToolConfig
): Promise<AsyncIterable<any>> {
  const { accessToken, projectId, accountId } = await getCredential();
  const url = getApiUrl('streamGenerateContent') + '?alt=sse';
  const body = buildRequestBody(modelName, projectId, contents, systemInstruction, generationConfig, tools, toolConfig);

  const response = await pfetch(url, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'text/event-stream',
    },
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
    throw new Error(`Gemini API 错误 (${response.status}): ${errorMessage}`);
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
              const parsed = JSON.parse(jsonStr) as any;
              yield unwrapResponse(parsed);
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
            const parsed = JSON.parse(jsonStr) as any;
            yield unwrapResponse(parsed);
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

export function isModelSupported(modelName: string): boolean {
  const config = getConfig();
  return config.gemini.supportedModels.some((m) => modelName.includes(m));
}

export { ensureValidCredentials } from './auth.js';

// --- CloudCode Backend class (wraps the above functions) ---

import { Backend } from './backend.js';

export class CloudCodeBackend implements Backend {
  readonly needsThoughtSignature = true;

  generateContent(
    modelName: string,
    contents: GeminiContent[],
    systemInstruction?: GeminiContent,
    generationConfig?: GeminiGenerationConfig,
    tools?: GeminiTool[],
    toolConfig?: GeminiToolConfig,
  ): Promise<any> {
    return generateContent(modelName, contents, systemInstruction, generationConfig, tools, toolConfig);
  }

  generateContentStream(
    modelName: string,
    contents: GeminiContent[],
    systemInstruction?: GeminiContent,
    generationConfig?: GeminiGenerationConfig,
    tools?: GeminiTool[],
    toolConfig?: GeminiToolConfig,
  ): Promise<AsyncIterable<any>> {
    return generateContentStream(modelName, contents, systemInstruction, generationConfig, tools, toolConfig);
  }

  isModelSupported(modelName: string): boolean {
    return isModelSupported(modelName);
  }
}
