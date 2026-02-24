import {
  GeminiContent,
  GeminiGenerationConfig,
  GeminiTool,
  GeminiToolConfig,
} from '../types/gemini.js';
import { getConfig } from '../config.js';
import { pfetch } from './http.js';
import { acquireCredential, AcquireCredentialOptions } from './rotation.js';
import { 
  setCredentialPreview, 
  setCredentialValidationRequired, 
  markCredentialRateLimited,
} from '../storage/credentials.js';
import { logError, logWarn } from './log-stream.js';

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

// Retry configuration - 增加重试次数以遍历更多凭证
const MAX_RETRIES = 10;

/**
 * Build the API URL for cloudcode-pa.googleapis.com/v1internal
 * Format: {base}:{method} (NOT {base}/publishers/google/models/{model}:{method})
 */
function getApiUrl(method: string): string {
  const config = getConfig();
  return `${config.gemini.apiEndpoint}:${method}`;
}

interface CredentialInfo {
  accessToken: string;
  projectId: string;
  accountId: string;
  credential: any;
}

async function getCredential(opts?: AcquireCredentialOptions): Promise<CredentialInfo> {
  const credential = await acquireCredential({ provider: 'gemini', ...opts });
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
    credential,
  };
}

/**
 * Check if error is a 403 account validation required error
 * Returns validation URL if applicable
 */
function parseValidationError(errorBody: string): { isValidationError: boolean; validationUrl?: string } {
  try {
    const errorJson = JSON.parse(errorBody);
    const error = errorJson.error;
    
    if (error?.code === 403 && error?.status === 'PERMISSION_DENIED') {
      const details = error.details;
      if (Array.isArray(details)) {
        for (const detail of details) {
          if (detail['@type']?.includes('ErrorInfo') && detail.reason === 'VALIDATION_REQUIRED') {
            const metadata = detail.metadata;
            if (metadata?.validation_url) {
              return {
                isValidationError: true,
                validationUrl: metadata.validation_url,
              };
            }
          }
        }
      }
      
      // Check error message for validation keywords
      const errorMsg = error?.message || '';
      if (errorMsg.includes('Verify your account') || errorMsg.includes('VALIDATION_REQUIRED')) {
        return { isValidationError: true };
      }
    }
  } catch {
    // Ignore parsing errors
  }
  return { isValidationError: false };
}

/**
 * Perform API request with retry logic
 * Simple credential rotation on errors - no cooldown tracking, just retry
 */
async function requestWithRetry(
  url: string,
  body: Record<string, unknown>,
  modelName: string,
  isStream: boolean = false
): Promise<Response | AsyncIterable<any>> {
  let lastError: Error | null = null;
  const triedCredentials = new Set<string>();
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Get next available credential
    const credential = await getCredential({ modelName });
    
    if (!credential) {
      throw new Error('没有可用的凭证，请检查认证状态');
    }
    
    const credKey = `${credential.accountId}:${credential.credential?.provider || 'gemini'}`;
    
    // If we've tried all credentials, continue anyway with retry delay
    if (triedCredentials.has(credKey)) {
      logWarn(`所有凭证已尝试一遍，等待后重试 (${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, 500));
    }
    triedCredentials.add(credKey);
    
    const { accessToken, projectId, accountId } = credential;
    
    // Update body with current project
    const requestBody = { ...body };
    requestBody.project = projectId;
    
    try {
      const response = await pfetch(url, {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          'Authorization': `Bearer ${accessToken}`,
          'Accept': isStream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const statusCode = response.status;
        
        // Parse error message for logging
        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.error?.status || errorText;
        } catch { /* use raw text */ }
        
        // Handle 403 account validation error - mark and retry
        if (statusCode === 403) {
          const validationInfo = parseValidationError(errorText);
          if (validationInfo.isValidationError) {
            logError(`凭证 ${accountId} 需要账号验证: ${validationInfo.validationUrl || '未知链接'}`);
            setCredentialValidationRequired(accountId, true, validationInfo.validationUrl, 'gemini');
            continue; // Try next credential
          }
        }
        
        // Handle 404 preview model error - mark and retry
        if (statusCode === 404 && modelName.toLowerCase().includes('preview')) {
          logWarn(`凭证 ${accountId} 不支持 preview 模型，标记为 non-preview`);
          setCredentialPreview(accountId, false, 'gemini');
          continue; // Try next credential
        }
        
        // Handle 429/503 - simply retry with next credential (no cooldown marking)
        if ((statusCode === 429 || statusCode === 503) && attempt < MAX_RETRIES - 1) {
          logWarn(`凭证 ${accountId} 触发限流 (${statusCode})，切换凭证重试 (${attempt + 1}/${MAX_RETRIES})`);
          continue;
        }
        
        // Handle auto-ban error codes
        const config = getConfig();
        const autoBanCodes = config.gemini.autoBanErrorCodes || [403];
        if (autoBanCodes.includes(statusCode)) {
          logError(`凭证 ${accountId} 返回 ${statusCode}，自动禁用`);
          markCredentialRateLimited(accountId, Math.floor(Date.now() / 1000) + 3600, 'gemini');
          continue; // Try next credential
        }
        
        // Non-retryable error - throw immediately
        throw new Error(`Gemini API 错误 (${statusCode}): ${errorMessage}`);
      }
      
      // Success - return response
      if (isStream) {
        return handleStreamResponse(response, accountId, modelName);
      }
      return response;
      
    } catch (error: any) {
      lastError = error;
      
      // Network errors - retry with next credential
      if (error.message?.includes('Network error') && attempt < MAX_RETRIES - 1) {
        logWarn(`网络错误，切换凭证重试 (${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }
      
      // If it's a thrown error from above (non-retryable), re-throw
      if (error.message?.includes('Gemini API 错误')) {
        throw error;
      }
      
      // Other errors - continue to next credential if not last attempt
      if (attempt < MAX_RETRIES - 1) {
        logWarn(`请求错误: ${error.message?.substring(0, 100)}，切换凭证重试 (${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError || new Error('所有重试均失败，没有可用凭证');
}

/**
 * Handle streaming response with proper error handling
 */
async function* handleStreamResponse(
  response: Response, 
  _accountId: string,
  _modelName: string
): AsyncIterable<any> {
  if (!response.body) {
    throw new Error('流式响应无数据');
  }

  const reader = response.body.getReader();
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
  const url = getApiUrl('generateContent');
  const body = buildRequestBody(modelName, '', contents, systemInstruction, generationConfig, tools, toolConfig);

  const response = await requestWithRetry(url, body, modelName, false) as Response;
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
  const url = getApiUrl('streamGenerateContent') + '?alt=sse';
  const body = buildRequestBody(modelName, '', contents, systemInstruction, generationConfig, tools, toolConfig);

  return await requestWithRetry(url, body, modelName, true) as AsyncIterable<any>;
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
