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
  listCredentials,
} from '../storage/credentials.js';
import { logWarn, logInfo } from './log-stream.js';

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
 * Parse cooldown from error response
 * Returns cooldown until timestamp (seconds) or null if no cooldown
 */
function parseCooldown(errorBody: string): number | null {
  try {
    const errorJson = JSON.parse(errorBody);
    const error = errorJson.error;
    
    // Check for QUOTA_EXHAUSTED with retry info
    if (error?.code === 429 || error?.status === 'RESOURCE_EXHAUSTED') {
      const details = error.details;
      if (Array.isArray(details)) {
        for (const detail of details) {
          if (detail['@type']?.includes('RetryInfo')) {
            const retryDelay = detail.retryDelay;
            if (retryDelay) {
              // Parse retryDelay (format: "60s" or { seconds: 60 })
              let seconds = 0;
              if (typeof retryDelay === 'string') {
                const match = retryDelay.match(/(\d+)s/);
                if (match) seconds = parseInt(match[1], 10);
              } else if (retryDelay.seconds) {
                seconds = parseInt(retryDelay.seconds, 10);
              }
              if (seconds > 0) {
                return Math.floor(Date.now() / 1000) + seconds;
              }
            }
          }
        }
      }
      
      // Check for x-goog-ext-251768198-bin header info in error message
      const errorMsg = error?.message || '';
      const cooldownMatch = errorMsg.match(/cooldown\s+(\d+)\s*seconds/i) || 
                           errorMsg.match(/retry\s+after\s+(\d+)\s*seconds/i);
      if (cooldownMatch) {
        return Math.floor(Date.now() / 1000) + parseInt(cooldownMatch[1], 10);
      }
    }
  } catch {
    // Ignore parsing errors
  }
  return null;
}

/**
 * Check if error is fatal (should not retry with other credentials)
 * 4xx errors (except 429, 403 validation, 404 preview) are client errors, should not retry
 */
function isFatalError(statusCode: number): boolean {
  // 5xx server errors - retry with other credentials
  if (statusCode >= 500 && statusCode !== 503) {
    return false;
  }
  // 429 rate limit - retry with other credentials
  if (statusCode === 429) {
    return false;
  }
  // 503 service unavailable - retry with other credentials
  if (statusCode === 503) {
    return false;
  }
  // 403, 404 with special handling - not fatal
  if (statusCode === 403 || statusCode === 404) {
    return false;
  }
  // Other 4xx errors are fatal (client errors)
  if (statusCode >= 400 && statusCode < 500) {
    return true;
  }
  return false;
}

/**
 * Request state for credential warming and fast updates
 */
interface RequestState {
  url: string;
  baseBody: Record<string, unknown>;  // Original body without project
  headers: Record<string, string>;
  modelName: string;
  isStream: boolean;
}

/**
 * Deep clone an object (safe for request bodies)
 */
function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime()) as unknown as T;
  if (obj instanceof Array) return obj.map(item => deepClone(item)) as unknown as T;
  if (typeof obj === 'object') {
    const cloned: Record<string, unknown> = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
      }
    }
    return cloned as T;
  }
  return obj;
}

/**
 * Fast credential update - only update changed fields
 * Instead of rebuilding entire request body
 */
function fastUpdateCredential(
  state: RequestState,
  credential: CredentialInfo
): { headers: Record<string, string>; body: Record<string, unknown> } {
  // Clone headers and update only Authorization
  const headers = { ...state.headers };
  headers['Authorization'] = `Bearer ${credential.accessToken}`;
  
  // Deep clone baseBody to avoid modifying nested objects
  const body = deepClone(state.baseBody);
  body.project = credential.projectId;
  
  return { headers, body };
}

/**
 * Perform API request with retry logic, credential warming, and fast updates
 * Try ALL available credentials before giving up
 * 
 * Optimizations:
 * 1. Credential warming: Pre-fetch next credential asynchronously
 * 2. 429 without cooldown: Retry with same credential
 * 3. Response caching: Cache error body to avoid re-decode
 * 4. Fast updates: Only update changed fields (token, project)
 */
async function requestWithRetry(
  url: string,
  body: Record<string, unknown>,
  modelName: string,
  isStream: boolean = false
): Promise<Response | AsyncIterable<any>> {
  const errors: Array<{ accountId: string; statusCode: number; message: string }> = [];
  const triedCredentials = new Set<string>();
  let credentialCount = 0;
  
  // Get all available gemini credentials
  const allCredentials = listCredentials().filter(c => c.provider === 'gemini' || !c.provider);
  const totalCredentials = allCredentials.length;
  
  if (totalCredentials === 0) {
    throw new Error('没有可用的 Gemini 凭证，请检查认证状态');
  }
  
  logWarn(`开始请求，共有 ${totalCredentials} 个凭证可用`);
  
  // Get initial credential
  let credential: CredentialInfo;
  try {
    credential = await getCredential({ modelName });
  } catch (e: any) {
    throw new Error(`获取凭证失败 (模型: ${modelName}): ${e.message}`);
  }
  
  // Prepare request state for fast updates
  const requestState: RequestState = {
    url,
    baseBody: { ...body },  // Store base body without project
    headers: {
      ...DEFAULT_HEADERS,
      'Accept': isStream ? 'text/event-stream' : 'application/json',
    },
    modelName,
    isStream,
  };
  
  // Variable to hold pre-warmed credential promise
  let warmedCredentialPromise: Promise<CredentialInfo | null> | null = null;
  
  // Helper to warm next credential
  const warmNextCredential = (): void => {
    if (!warmedCredentialPromise && credentialCount < totalCredentials) {
      warmedCredentialPromise = (async () => {
        try {
          return await getCredential({ modelName });
        } catch {
          return null;
        }
      })();
    }
  };
  
  // Helper to get warmed credential
  const getWarmedCredential = async (): Promise<CredentialInfo | null> => {
    if (warmedCredentialPromise) {
      const cred = await warmedCredentialPromise;
      warmedCredentialPromise = null;
      return cred;
    }
    return null;
  };
  
  while (credentialCount < totalCredentials) {
    const credKey = `${credential.accountId}:gemini`;
    
    // Skip if already tried this credential
    if (triedCredentials.has(credKey)) {
      // Try to get next credential
      const nextCred = await getWarmedCredential();
      if (nextCred) {
        credential = nextCred;
      } else {
        try {
          credential = await getCredential({ modelName });
        } catch {
          break;
        }
      }
      credentialCount++;
      continue;
    }
    
    triedCredentials.add(credKey);
    credentialCount++;
    
    const { accountId } = credential;
    
    // Use fast update to prepare request
    const { headers, body: requestBody } = fastUpdateCredential(requestState, credential);
    
    // Pre-warm next credential for faster switching on error
    warmNextCredential();
    
    try {
      const response = await pfetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        // Cache error body to avoid re-decode
        const errorText = await response.text();
        const statusCode = response.status;
        
        // Parse error message for logging (cached)
        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.error?.status || errorText;
        } catch { /* use raw text */ }
        
        // Record this error
        errors.push({ accountId, statusCode, message: errorMessage.substring(0, 200) });
        
        // Handle 403 account validation error - mark and try next credential
        if (statusCode === 403) {
          const validationInfo = parseValidationError(errorText);
          if (validationInfo.isValidationError) {
            logWarn(`凭证 ${accountId} 需要账号验证，尝试下一个凭证...`);
            setCredentialValidationRequired(accountId, true, validationInfo.validationUrl, 'gemini');
            const nextCred = await getWarmedCredential() || await getCredential({ modelName }).catch(() => null);
            if (nextCred) credential = nextCred;
            continue;
          }
          // 403 without validation - might be permission issue, try next
          logWarn(`凭证 ${accountId} 返回 403，尝试下一个凭证...`);
          const nextCred = await getWarmedCredential() || await getCredential({ modelName }).catch(() => null);
          if (nextCred) credential = nextCred;
          continue;
        }
        
        // Handle 404 preview model error - mark and try next credential
        if (statusCode === 404 && modelName.toLowerCase().includes('preview')) {
          logWarn(`凭证 ${accountId} 不支持 preview 模型，标记为 non-preview，尝试下一个凭证...`);
          setCredentialPreview(accountId, false, 'gemini');
          const nextCred = await getWarmedCredential() || await getCredential({ modelName }).catch(() => null);
          if (nextCred) credential = nextCred;
          continue;
        }
        
        // Handle 429/503 - check for cooldown
        if (statusCode === 429 || statusCode === 503) {
          const cooldownUntil = parseCooldown(errorText);
          
          if (cooldownUntil) {
            // Has cooldown - mark and switch credential
            logWarn(`凭证 ${accountId} 触发限流 (${statusCode})，冷却至 ${new Date(cooldownUntil * 1000).toISOString()}，切换凭证`);
            markCredentialRateLimited(accountId, cooldownUntil, 'gemini');
          } else {
            // No cooldown - keep current credential and retry after short delay
            logInfo(`凭证 ${accountId} 触发限流 (${statusCode}) 但无冷却时间，保留凭证稍后重试`);
            await new Promise(r => setTimeout(r, 1000)); // 1s delay
            // Don't consume warmed credential, retry with same credential
            credentialCount--; // Don't count this as an attempt
            continue;
          }
          
          const nextCred = await getWarmedCredential() || await getCredential({ modelName }).catch(() => null);
          if (nextCred) credential = nextCred;
          continue;
        }
        
        // Handle auto-ban error codes - mark but still try next credential
        const config = getConfig();
        const autoBanCodes = config.gemini.autoBanErrorCodes || [403];
        if (autoBanCodes.includes(statusCode)) {
          logWarn(`凭证 ${accountId} 返回 ${statusCode}，自动禁用，尝试下一个凭证...`);
          markCredentialRateLimited(accountId, Math.floor(Date.now() / 1000) + 3600, 'gemini');
          const nextCred = await getWarmedCredential() || await getCredential({ modelName }).catch(() => null);
          if (nextCred) credential = nextCred;
          continue;
        }
        
        // Check if fatal error (should not retry)
        if (isFatalError(statusCode)) {
          throw new Error(`Gemini API 错误 (${statusCode}): ${errorMessage}`);
        }
        
        // Other errors - try next credential
        logWarn(`凭证 ${accountId} 返回 ${statusCode}，尝试下一个凭证...`);
        const nextCred = await getWarmedCredential() || await getCredential({ modelName }).catch(() => null);
        if (nextCred) credential = nextCred;
        continue;
      }
      
      // Success - return response
      if (isStream) {
        return handleStreamResponse(response, accountId, modelName);
      }
      return response;
      
    } catch (error: any) {
      // Record error
      const errorMsg = error.message || '未知错误';
      errors.push({ accountId, statusCode: 0, message: errorMsg.substring(0, 200) });
      
      // Network errors - try next credential
      if (error.message?.includes('Network error')) {
        logWarn(`凭证 ${accountId} 网络错误，尝试下一个凭证 (${credentialCount}/${totalCredentials})...`);
        const nextCred = await getWarmedCredential() || await getCredential({ modelName }).catch(() => null);
        if (nextCred) credential = nextCred;
        continue;
      }
      
      // If it's a thrown error from above (non-retryable), re-throw
      if (error.message?.includes('Gemini API 错误') && isFatalError(parseInt(error.message.match(/\((\d+)\)/)?.[1] || '0'))) {
        throw error;
      }
      
      // Other errors - try next credential
      logWarn(`凭证 ${accountId} 请求错误: ${errorMsg.substring(0, 100)}，尝试下一个凭证 (${credentialCount}/${totalCredentials})...`);
      const nextCred = await getWarmedCredential() || await getCredential({ modelName }).catch(() => null);
      if (nextCred) credential = nextCred;
      continue;
    }
  }
  
  // All credentials exhausted - construct comprehensive error message
  const uniqueErrors = new Map<number, string>();
  for (const err of errors) {
    if (!uniqueErrors.has(err.statusCode)) {
      uniqueErrors.set(err.statusCode, err.message);
    }
  }
  
  const errorSummary = Array.from(uniqueErrors.entries())
    .map(([code, msg]) => `[${code}] ${msg.substring(0, 100)}`)
    .join('; ');
  
  throw new Error(`所有 ${totalCredentials} 个凭证均请求失败 (模型: ${modelName})。错误汇总: ${errorSummary || '未知错误'}`);
}

/**
 * Handle streaming response with proper error handling
 * Includes response body caching for error optimization
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
          const unwrapped = unwrapResponse(parsed);
          yield unwrapped;
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
  _projectId: string,  // project is now added dynamically via fastUpdateCredential
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
    // project will be added dynamically by fastUpdateCredential
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
