import {
  OpenAIMessage,
  OpenAIChatCompletionRequest,
  OpenAIMessageContent,
} from '../types/openai.js';
import {
  GeminiContent,
  GeminiGenerationConfig,
  GeminiFunctionDeclaration,
  GeminiTool,
  GeminiToolConfig,
  GeminiFunctionResponsePart,
  GeminiThinkingConfig,
  GeminiSystemInstruction,
} from '../types/gemini.js';
import { normalizeFunctionName } from './pinyin.js';
import { logWarn, logInfo } from './log-stream.js';
import { getConfig } from '../config.js';

export interface ConvertOptions {
  includeThoughtSignature?: boolean;
}

// Separator for encoding thoughtSignature in tool_call_id
const THOUGHT_SIGNATURE_SEPARATOR = '__thought__';

/**
 * Encode thoughtSignature into tool_call_id to preserve it across round-trips
 * This ensures the signature is retained even if the client strips custom fields
 */
export function encodeToolIdWithSignature(toolId: string, signature: string | null | undefined): string {
  if (!signature) {
    return toolId;
  }
  return `${toolId}${THOUGHT_SIGNATURE_SEPARATOR}${signature}`;
}

/**
 * Decode tool_call_id to extract original tool ID and thoughtSignature
 */
export function decodeToolIdAndSignature(encodedId: string): { toolId: string; signature?: string } {
  if (!encodedId || !encodedId.includes(THOUGHT_SIGNATURE_SEPARATOR)) {
    return { toolId: encodedId };
  }
  const parts = encodedId.split(THOUGHT_SIGNATURE_SEPARATOR);
  return {
    toolId: parts[0],
    signature: parts.length >= 2 ? parts[1] : undefined,
  };
}

/**
 * Build a map from tool_call_id to function name from assistant messages
 * Also tracks thoughtSignatures encoded in tool IDs
 */
function buildToolCallIdToNameMap(messages: OpenAIMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const toolCalls = (msg as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          // Decode in case the ID has encoded signature
          const { toolId } = decodeToolIdAndSignature(tc.id);
          if (toolId && tc.function?.name) {
            map.set(toolId, tc.function.name);
          }
        }
      }
    }
  }
  return map;
}

/**
 * Parse base64 data URL to extract mime type and data
 */
function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  if (!url.startsWith('data:')) return null;
  
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) return null;
  
  const header = url.substring(5, commaIndex);
  const data = url.substring(commaIndex + 1);
  
  // Parse mime type from header (e.g., "image/png;base64")
  const semiIndex = header.indexOf(';');
  const mimeType = semiIndex !== -1 ? header.substring(0, semiIndex) : header;
  
  return { mimeType, data };
}

/**
 * Convert OpenAI message content to Gemini parts
 */
function convertContentToParts(content: OpenAIMessageContent): any[] {
  // String content
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  
  // Array content (multimodal)
  if (Array.isArray(content)) {
    const parts: any[] = [];
    
    for (const item of content) {
      if (item.type === 'text') {
        parts.push({ text: item.text });
      } else if (item.type === 'image_url') {
        const parsed = parseDataUrl(item.image_url.url);
        if (parsed) {
          parts.push({
            inlineData: {
              mimeType: parsed.mimeType,
              data: parsed.data,
            },
          });
        }
      }
    }
    
    return parts;
  }
  
  return [];
}

/**
 * Convert OpenAI messages to Gemini contents format
 */
export function convertMessagesToContents(
  messages: OpenAIMessage[],
  options?: ConvertOptions
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const includeThought = options?.includeThoughtSignature ?? true;
  
  // Process thinking blocks: filter invalid ones and sanitize
  const processedMessages = processThinkingBlocks(messages);
  
  // Build tool_call_id -> function name mapping for tool responses
  const toolCallIdToName = buildToolCallIdToNameMap(processedMessages);

  for (const msg of processedMessages) {
    // Skip system messages - Gemini uses systemInstruction separately
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      contents.push({
        role: 'user',
        parts: convertContentToParts(msg.content),
      });
    } else if (msg.role === 'assistant') {
      const parts: any[] = [];

      // Handle content (text or multimodal)
      if (msg.content) {
        if (typeof msg.content === 'string' && msg.content) {
          parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          parts.push(...convertContentToParts(msg.content));
        }
      }

      // Handle tool calls - add thoughtSignature for cloudcode-pa API
      if ((msg as any).tool_calls) {
        for (const toolCall of (msg as any).tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }
          
          // Normalize function name for Gemini API compatibility
          const normalizedName = normalizeFunctionName(toolCall.function.name);
          
          // Fix argument types based on cached tool schema
          const toolSchema = getToolSchema(normalizedName);
          if (toolSchema) {
            args = fixToolCallArgsTypes(args, toolSchema);
          }
          
          // Decode tool ID in case it has encoded signature from previous turn
          const { toolId, signature } = decodeToolIdAndSignature(toolCall.id);
          // Use original tool ID or generate a new one
          const callId = toolId || toolCall.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          const part: any = {
            functionCall: {
              id: callId,
              name: normalizedName,
              args,
            },
          };
          
          if (includeThought) {
            // Use existing signature from decoded ID or generate new one
            part.thoughtSignature = signature || 'skip_thought_signature_validator';
          }
          
          parts.push(part);
        }
      }

      contents.push({
        role: 'model',
        parts,
      });
    } else if (msg.role === 'tool') {
      // Map tool_call_id to function name
      const toolCallId = (msg as any).tool_call_id;
      // Decode in case it has encoded signature
      const { toolId } = decodeToolIdAndSignature(toolCallId);
      const functionName = toolId ? (toolCallIdToName.get(toolId) || (msg as any).name) : (msg as any).name;
      
      // Normalize function name
      const normalizedName = functionName ? normalizeFunctionName(functionName) : '';
      
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: normalizedName,
              response: { result: msg.content },
            },
          } as GeminiFunctionResponsePart,
        ],
      });
    }
  }

  // Clean up contents: filter empty parts and fix text field types
  const cleanedContents: GeminiContent[] = [];
  for (const content of contents) {
    if (!content.parts || !Array.isArray(content.parts)) continue;
    
    const validParts: any[] = [];
    for (const part of content.parts) {
      if (!part || typeof part !== 'object') continue;
      
      const p = part as any;  // Cast to any for flexible property access
      
      // Check if part has valid non-empty value
      let hasValidValue = false;
      
      // Check text field
      if (typeof p.text === 'string' && p.text.trim()) {
        hasValidValue = true;
      }
      // Check inlineData field
      else if (p.inlineData && typeof p.inlineData === 'object' && 
               p.inlineData.data && p.inlineData.mimeType) {
        hasValidValue = true;
      }
      // Check functionCall field
      else if (p.functionCall && typeof p.functionCall === 'object' && p.functionCall.name) {
        hasValidValue = true;
      }
      // Check functionResponse field
      else if (p.functionResponse && typeof p.functionResponse === 'object' && p.functionResponse.name) {
        hasValidValue = true;
      }
      // Check thought field (valid even if empty)
      else if (p.thought !== undefined || p.thoughtSignature !== undefined) {
        hasValidValue = true;
      }
      
      if (!hasValidValue) continue;
      
      const cleanedPart = { ...part };
      
      // Fix text field: ensure it's a string, not a list
      if ('text' in cleanedPart) {
        const textValue = cleanedPart.text;
        if (Array.isArray(textValue)) {
          cleanedPart.text = (textValue as string[]).filter(t => t).join(' ');
        } else if (typeof textValue !== 'string') {
          cleanedPart.text = String(textValue);
        }
        // Trim trailing whitespace
        if (typeof cleanedPart.text === 'string') {
          cleanedPart.text = cleanedPart.text.trimEnd();
        }
      }
      
      validParts.push(cleanedPart);
    }
    
    if (validParts.length > 0) {
      cleanedContents.push({
        role: content.role,
        parts: validParts,
      });
    }
  }
  
  // Handle empty contents: add default user message
  if (cleanedContents.length === 0) {
    cleanedContents.push({
      role: 'user',
      parts: [{ text: '请根据系统指令回答。' }],
    });
  }

  return cleanedContents;
}

/**
 * Extract system instruction from messages if present
 * Note: Gemini systemInstruction only has parts, no role field
 */
export function extractSystemInstruction(
  messages: OpenAIMessage[]
): GeminiSystemInstruction | undefined {
  const systemMsg = messages.find((m) => m.role === 'system');
  if (!systemMsg) return undefined;

  return {
    parts: convertContentToParts(systemMsg.content),
  };
}

/**
 * Parse thinking settings from model name
 * 
 * Supports two formats:
 * 1. Parentheses format (CLIProxyAPI style): gemini-2.5-pro(8192), gemini-3-pro(high)
 * 2. Hyphen suffix format: gemini-2.5-pro-high, gemini-2.5-pro-medium
 * 
 * Priority: parentheses format > hyphen suffix format
 */
export function getThinkingSettingsFromModel(modelName: string): { thinkingBudget?: number; thinkingLevel?: string; baseModel?: string } | null {
  // First, try to parse parentheses format: model-name(value)
  const suffixResult = parseThinkingSuffix(modelName);
  if (suffixResult.hasSuffix) {
    return suffixResult.config;
  }
  
  // Fallback to hyphen suffix format
  const lowerModel = modelName.toLowerCase();
  
  // Check for thinking-related suffixes
  const isGemini25 = lowerModel.includes('gemini-2.5');
  const isGemini3 = lowerModel.includes('gemini-3');
  const isFlash = lowerModel.includes('flash');
  
  // Handle old-style suffixes
  if (lowerModel.includes('-nothinking')) {
    if (isFlash) {
      return { thinkingBudget: 0 };
    }
    return { thinkingBudget: 128 };
  }
  
  if (lowerModel.includes('-maxthinking')) {
    if (isGemini3) {
      return { thinkingLevel: 'high' };
    }
    const budget = isFlash ? 24576 : 32768;
    return { thinkingBudget: budget };
  }
  
  // Handle new-style budget/level suffixes
  if (lowerModel.includes('-max')) {
    if (isGemini25) {
      const budget = isFlash ? 24576 : 32768;
      return { thinkingBudget: budget };
    } else if (isGemini3) {
      return { thinkingLevel: 'high' };
    }
  }
  
  if (lowerModel.includes('-high')) {
    if (isGemini25) {
      return { thinkingBudget: 16000 };
    } else if (isGemini3) {
      return { thinkingLevel: 'high' };
    }
  }
  
  if (lowerModel.includes('-medium')) {
    if (isGemini25) {
      return { thinkingBudget: 8192 };
    } else if (isGemini3) {
      return { thinkingLevel: 'medium' };
    }
  }

  if (lowerModel.includes('-low')) {
    if (isGemini25) {
      return { thinkingBudget: 1024 };
    } else if (isGemini3) {
      return { thinkingLevel: 'low' };
    }
  }
  
  if (lowerModel.includes('-minimal')) {
    if (isGemini25) {
      const budget = isFlash ? 0 : 128;
      return { thinkingBudget: budget };
    }
  }
  
  return null;
}

/**
 * Parse thinking suffix from model name in parentheses format
 * 
 * Format: model-name(value) where value can be:
 * - Numeric budget: gemini-2.5-pro(8192) -> thinkingBudget: 8192
 * - Level name: gemini-3-pro(high) -> thinkingLevel: 'high'
 * - Special values: model(auto), model(none), model(-1)
 * 
 * Reference: CLIProxyAPI internal/thinking/suffix.go
 */
function parseThinkingSuffix(modelName: string): { hasSuffix: boolean; config: { thinkingBudget?: number; thinkingLevel?: string; baseModel?: string } | null } {
  // Find the last opening parenthesis
  const lastOpen = modelName.lastIndexOf('(');
  if (lastOpen === -1) {
    return { hasSuffix: false, config: null };
  }
  
  // Check if the string ends with a closing parenthesis
  if (!modelName.endsWith(')')) {
    return { hasSuffix: false, config: null };
  }
  
  // Extract components
  const baseModel = modelName.substring(0, lastOpen);
  const rawSuffix = modelName.substring(lastOpen + 1, modelName.length - 1);
  
  if (!rawSuffix) {
    return { hasSuffix: false, config: null };
  }
  
  // Parse suffix value
  const lowerSuffix = rawSuffix.toLowerCase();
  
  // 1. Special values: 'none', 'auto', '-1'
  if (lowerSuffix === 'none') {
    return {
      hasSuffix: true,
      config: { thinkingBudget: 0, thinkingLevel: 'none', baseModel },
    };
  }
  
  if (lowerSuffix === 'auto' || lowerSuffix === '-1') {
    return {
      hasSuffix: true,
      config: { thinkingBudget: -1, baseModel },
    };
  }
  
  // 2. Level names: 'minimal', 'low', 'medium', 'high', 'xhigh'
  const levelMap: Record<string, string> = {
    'minimal': 'minimal',
    'low': 'low',
    'medium': 'medium',
    'high': 'high',
    'xhigh': 'xhigh',
  };
  
  if (levelMap[lowerSuffix]) {
    return {
      hasSuffix: true,
      config: { thinkingLevel: levelMap[lowerSuffix], baseModel },
    };
  }
  
  // 3. Numeric budget
  const budget = parseInt(rawSuffix, 10);
  if (!isNaN(budget) && budget >= 0) {
    return {
      hasSuffix: true,
      config: { thinkingBudget: budget, baseModel },
    };
  }
  
  // Unknown suffix format
  return { hasSuffix: false, config: null };
}

/**
 * Level to budget mapping (reference: CLIProxyAPI)
 */
const levelToBudgetMap: Record<string, number> = {
  'none': 0,
  'auto': -1,
  'minimal': 512,
  'low': 1024,
  'medium': 8192,
  'high': 24576,
  'xhigh': 32768,
};

/**
 * Convert thinking level to budget value
 */
export function convertLevelToBudget(level: string): number | undefined {
  return levelToBudgetMap[level.toLowerCase()];
}

/**
 * Check if model is a search model
 */
export function isSearchModel(modelName: string): boolean {
  return modelName.toLowerCase().includes('-search');
}

/**
 * Get base model name by removing feature suffixes
 * Supports both hyphen suffix format and parentheses format
 */
export function getBaseModelName(modelName: string): string {
  // First, check for parentheses format: model-name(value)
  const lastOpen = modelName.lastIndexOf('(');
  if (lastOpen !== -1 && modelName.endsWith(')')) {
    const baseModel = modelName.substring(0, lastOpen);
    if (baseModel) {
      return baseModel;
    }
  }
  
  // Fallback to hyphen suffix format
  // Order from longest to shortest to avoid partial matches
  const suffixes = [
    '-maxthinking', '-nothinking',  // Legacy
    '-minimal', '-medium', '-search', '-think',  // Medium length
    '-high', '-max', '-low',  // Short
  ];
  
  let result = modelName;
  let changed = true;
  
  // Keep removing suffixes until no more changes
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (result.toLowerCase().endsWith(suffix)) {
        result = result.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  
  return result;
}

/**
 * Convert reasoning_effort to Gemini thinkingConfig
 * 
 * Reference: CLIProxyAPI thinking package
 * - 'auto': thinkingBudget = -1, includeThoughts = true
 * - 'none': thinkingBudget = 0, includeThoughts = false (Gemini 2.5)
 *          OR thinkingLevel = 'none', includeThoughts = false (Gemini 3.x)
 * - 'low'/'medium'/'high': thinkingLevel = effort, includeThoughts = true
 */
function convertReasoningEffort(effort?: 'low' | 'medium' | 'high' | 'auto' | 'none'): GeminiThinkingConfig | undefined {
  if (!effort) return undefined;
  
  if (effort === 'auto') {
    return {
      thinkingBudget: -1,
      includeThoughts: true,
    };
  }
  
  if (effort === 'none') {
    // For 'none', we need to explicitly disable thinking
    // Use thinkingBudget: 0 for Gemini 2.5, thinkingLevel: 'none' for Gemini 3.x
    // The model-specific handling is done in the provider
    return {
      thinkingBudget: 0,
      thinkingLevel: 'none',
      includeThoughts: false,
    };
  }
  
  // 'low', 'medium', 'high' - use thinkingLevel
  return {
    thinkingLevel: effort,
    includeThoughts: true,
  };
}

/**
 * Type guards for additional request parameters
 */
function hasTopK(req: any): req is { top_k: number } {
  return typeof req?.top_k === 'number';
}

function hasSeed(req: any): req is { seed: number } {
  return typeof req?.seed === 'number';
}

function hasFrequencyPenalty(req: any): req is { frequency_penalty: number } {
  return typeof req?.frequency_penalty === 'number';
}

function hasPresencePenalty(req: any): req is { presence_penalty: number } {
  return typeof req?.presence_penalty === 'number';
}

function hasResponseMimeType(req: any): req is { response_mime_type: string } {
  return typeof req?.response_mime_type === 'string';
}

function hasResponseSchema(req: any): req is { response_schema: Record<string, unknown> } {
  return typeof req?.response_schema === 'object' && req?.response_schema !== null;
}

/**
 * Convert OpenAI chat completion request config to Gemini generation config
 * Includes model name-based thinking settings
 */
export function convertToGeminiConfig(
  request: OpenAIChatCompletionRequest
): GeminiGenerationConfig {
  const config: GeminiGenerationConfig = {};

  if (request.temperature !== undefined) {
    config.temperature = request.temperature;
  }

  if (request.top_p !== undefined) {
    config.topP = request.top_p;
  }

  if (request.max_tokens !== undefined) {
    config.maxOutputTokens = request.max_tokens;
  }

  if (request.stop !== undefined) {
    config.stopSequences = Array.isArray(request.stop)
      ? request.stop
      : [request.stop];
  }

  // Additional parameters with type guards
  if (hasTopK(request)) {
    config.topK = request.top_k;
  }

  if (hasSeed(request)) {
    config.seed = request.seed;
  }

  if (hasFrequencyPenalty(request)) {
    config.frequencyPenalty = request.frequency_penalty;
  }

  if (hasPresencePenalty(request)) {
    config.presencePenalty = request.presence_penalty;
  }

  if (hasResponseMimeType(request)) {
    config.responseMimeType = request.response_mime_type;
  }

  if (hasResponseSchema(request)) {
    config.responseSchema = request.response_schema;
  }

  // Convert reasoning_effort or thinking_budget to thinkingConfig
  // First check explicit settings, then parse from model name
  // 
  // includeThoughts logic (reference: gcli2api normalize_gemini_request):
  // 1. For pro models: includeThoughts = returnThoughtsToFrontend (config)
  // 2. For Gemini 3 flash: if no thinkingLevel set, includeThoughts = false
  // 3. For Gemini 2.5 flash: if no thinkingBudget set, don't add thinkingConfig
  // 4. For other cases: includeThoughts based on whether budget/level is set and not 0/none
  
  const returnThoughtsToFrontend = getConfig().returnThoughtsToFrontend ?? true;
  const baseModel = getBaseModelName(request.model).toLowerCase();
  const isProModel = baseModel.includes('pro');
  const isFlashModel = baseModel.includes('flash');
  const isGemini3 = baseModel.includes('gemini-3');
  const isGemini25 = baseModel.includes('gemini-2.5');
  
  if (request.thinking_budget !== undefined) {
    // Direct thinking budget takes precedence
    config.thinkingConfig = {
      thinkingBudget: request.thinking_budget,
      includeThoughts: request.thinking_budget !== 0 && returnThoughtsToFrontend,
    };
  } else if (request.reasoning_effort !== undefined) {
    const effortConfig = convertReasoningEffort(request.reasoning_effort);
    if (effortConfig) {
      // Override includeThoughts based on config for non-'none' efforts
      if (request.reasoning_effort !== 'none') {
        effortConfig.includeThoughts = returnThoughtsToFrontend;
      }
      config.thinkingConfig = effortConfig;
    }
  } else {
    // Parse thinking settings from model name
    const modelThinkingSettings = getThinkingSettingsFromModel(request.model);
    if (modelThinkingSettings) {
      // Determine includeThoughts based on model type and settings
      let includeThoughts: boolean;
      
      if (isProModel) {
        // Pro models: use config setting
        includeThoughts = returnThoughtsToFrontend;
      } else if (isGemini3 && isFlashModel) {
        // Gemini 3 flash: only include thoughts if thinkingLevel is set
        includeThoughts = modelThinkingSettings.thinkingLevel != null 
          ? returnThoughtsToFrontend 
          : false;
      } else if (isGemini25 && isFlashModel) {
        // Gemini 2.5 flash: only include thoughts if thinkingBudget is set and > 0
        includeThoughts = modelThinkingSettings.thinkingBudget != null && 
          modelThinkingSettings.thinkingBudget > 0 
          ? returnThoughtsToFrontend 
          : false;
      } else {
        // Other models: use default logic
        if (modelThinkingSettings.thinkingBudget === 0) {
          includeThoughts = false;
        } else if (modelThinkingSettings.thinkingLevel === 'none') {
          includeThoughts = false;
        } else {
          includeThoughts = returnThoughtsToFrontend;
        }
      }
      
      config.thinkingConfig = {
        thinkingBudget: modelThinkingSettings.thinkingBudget,
        thinkingLevel: modelThinkingSettings.thinkingLevel as any,
        includeThoughts,
      };
    } else if (isProModel) {
      // Pro model without explicit thinking settings: still enable thinking with default
      // This ensures pro models always have thinkingConfig to return thoughts
      config.thinkingConfig = {
        includeThoughts: returnThoughtsToFrontend,
      };
    }
  }

  // Convert modalities to responseModalities
  if (request.modalities && request.modalities.length > 0) {
    config.responseModalities = request.modalities.map(m => 
      m === 'image' ? 'IMAGE' : 'TEXT'
    );
  }

  // Convert image_config
  if (request.image_config) {
    config.imageConfig = {};
    if (request.image_config.aspect_ratio) {
      config.imageConfig.aspectRatio = request.image_config.aspect_ratio;
    }
    if (request.image_config.image_size) {
      config.imageConfig.imageSize = request.image_config.image_size;
    }
  }

  return config;
}

/**
 * Convert OpenAI tools to Gemini format.
 * Supports function declarations and special tools (google_search, code_execution, url_context).
 * Normalizes function names for Gemini API compatibility.
 */
export function convertToolsToGemini(
  tools?: any[]
): GeminiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const functionDeclarations: GeminiFunctionDeclaration[] = [];
  const specialTools: any[] = [];

  for (const tool of tools) {
    if (tool?.type === 'function' && tool.function?.name) {
      // Normalize function name for Gemini API compatibility
      const normalizedName = normalizeFunctionName(tool.function.name);
      
      functionDeclarations.push({
        name: normalizedName,
        description: tool.function.description || '',
        parametersJsonSchema: cleanSchemaForGemini(tool.function.parameters),
      });
    } else if (tool?.google_search || tool?.googleSearch) {
      // Google Search tool - support both snake_case and camelCase
      specialTools.push({ googleSearch: tool.google_search || tool.googleSearch });
    } else if (tool?.code_execution || tool?.codeExecution) {
      // Code Execution tool - support both snake_case and camelCase
      specialTools.push({ codeExecution: tool.code_execution || tool.codeExecution });
    } else if (tool?.url_context || tool?.urlContext) {
      // URL Context tool - support both snake_case and camelCase
      specialTools.push({ urlContext: tool.url_context || tool.urlContext });
    }
  }

  const result: GeminiTool[] = [];
  
  if (functionDeclarations.length > 0) {
    result.push({ functionDeclarations });
  }
  
  // Add special tools (each as separate tool object)
  for (const special of specialTools) {
    result.push(special);
  }
  
  return result.length > 0 ? result : undefined;
}

/**
 * Resolve $ref in JSON schema
 */
function resolveRef(ref: string, rootSchema: Record<string, unknown>): Record<string, unknown> | null {
  if (!ref.startsWith('#/')) {
    return null;
  }
  
  const path = ref.slice(2).split('/');
  let current: any = rootSchema;
  
  for (const segment of path) {
    if (current === undefined || current === null) {
      return null;
    }
    current = current[segment];
  }
  
  return typeof current === 'object' && current !== null ? current : null;
}



/**
 * Clean JSON schema for Gemini compatibility
 * Includes $ref resolution and cycle detection
 */
function cleanSchemaForGemini(
  schema: Record<string, unknown> | undefined,
  rootSchema?: Record<string, unknown>,
  visited?: WeakSet<object>
): any {
  // Default schema if none provided
  if (!schema || Object.keys(schema).length === 0) {
    return {
      type: 'object',
      properties: {},
    };
  }

  // Initialize root schema and visited set for cycle detection
  const root = rootSchema ?? schema;
  const seen = visited ?? new WeakSet<object>();
  
  // Check for circular reference
  if (seen.has(schema)) {
    // Return a placeholder for circular references
    return {
      type: 'object',
      description: '(circular reference)',
    };
  }
  
  // Mark as visited
  seen.add(schema);

  try {
    // Create a copy to avoid modifying the original
    let cleaned: Record<string, unknown> = {};
    
    // Handle $ref - resolve and merge
    if (schema.$ref && typeof schema.$ref === 'string') {
      const resolved = resolveRef(schema.$ref, root);
      if (resolved) {
        // Check if resolved schema is already visited (circular through $ref)
        if (seen.has(resolved)) {
          return {
            type: 'object',
            description: '(circular reference)',
          };
        }
        
        // Merge resolved schema with current (excluding $ref)
        cleaned = { ...(resolved as Record<string, unknown>) };
        for (const [key, value] of Object.entries(schema)) {
          if (key !== '$ref') {
            cleaned[key] = value;
          }
        }
      } else {
        // If resolution fails, copy the schema as-is (minus $ref)
        for (const [key, value] of Object.entries(schema)) {
          if (key !== '$ref') {
            cleaned[key] = value;
          }
        }
      }
    } else {
      cleaned = { ...schema };
    }

    // Remove fields not supported by Gemini
    delete cleaned.$ref;  // Already handled above
    delete cleaned.$defs;
    delete cleaned.definitions;
    delete cleaned.strict;
    delete cleaned.$schema;
    delete cleaned.additionalProperties;

    // Process allOf - merge schemas
    if (cleaned.allOf && Array.isArray(cleaned.allOf)) {
      const merged: any = {
        type: 'object',
        properties: {},
        required: [],
      };

      for (const item of cleaned.allOf) {
        const cleanedItem = cleanSchemaForGemini(item as Record<string, unknown>, root, seen);
        if (cleanedItem.properties) {
          Object.assign(merged.properties, cleanedItem.properties);
        }
        if (cleanedItem.required) {
          merged.required.push(...cleanedItem.required);
        }
        // Copy other fields
        for (const [key, value] of Object.entries(cleanedItem)) {
          if (key !== 'properties' && key !== 'required') {
            merged[key] = value;
          }
        }
      }

      // Copy other fields from cleaned (excluding allOf)
      for (const [key, value] of Object.entries(cleaned)) {
        if (key !== 'allOf') {
          if (key === 'properties' && merged.properties && typeof value === 'object' && value !== null) {
            merged.properties = { ...merged.properties, ...(value as Record<string, unknown>) };
          } else if (key === 'required' && merged.required) {
            merged.required = [...merged.required, ...(Array.isArray(value) ? value : [])];
          } else {
            merged[key] = value;
          }
        }
      }

      // Deduplicate required
      if (merged.required) {
        merged.required = [...new Set(merged.required)];
      }

      cleaned = merged;
    }

    // Process properties recursively
    if (cleaned.properties && typeof cleaned.properties === 'object') {
      const newProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(cleaned.properties as Record<string, unknown>)) {
        newProps[key] = cleanSchemaForGemini(value as Record<string, unknown>, root, seen);
      }
      cleaned.properties = newProps;
    }

    // Process items
    if (cleaned.items) {
      if (Array.isArray(cleaned.items)) {
        cleaned.items = cleaned.items.map(item => 
          cleanSchemaForGemini(item as Record<string, unknown>, root, seen)
        );
      } else {
        cleaned.items = cleanSchemaForGemini(cleaned.items as Record<string, unknown>, root, seen);
      }
    }

    // Process anyOf
    if (cleaned.anyOf && Array.isArray(cleaned.anyOf)) {
      cleaned.anyOf = cleaned.anyOf.map(item => 
        cleanSchemaForGemini(item as Record<string, unknown>, root, seen)
      );
    }

    // Process oneOf
    if (cleaned.oneOf && Array.isArray(cleaned.oneOf)) {
      cleaned.oneOf = cleaned.oneOf.map(item => 
        cleanSchemaForGemini(item as Record<string, unknown>, root, seen)
      );
    }

    // Process additionalProperties if it's an object
    if (cleaned.additionalProperties && typeof cleaned.additionalProperties === 'object') {
      cleaned.additionalProperties = cleanSchemaForGemini(
        cleaned.additionalProperties as Record<string, unknown>,
        root,
        seen
      );
    }

    return cleaned;
  } finally {
    // Always remove from visited set when done (even if an error occurs)
    seen.delete(schema);
  }
}

/**
 * Convert tool choice to Gemini tool config
 */
export function convertToolChoice(toolChoice?: any): GeminiToolConfig | undefined {
  if (!toolChoice) return undefined;

  // Handle string format: "none", "auto", "required"
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') {
      return { functionCallingConfig: { mode: 'NONE' } };
    }
    if (toolChoice === 'required') {
      return { functionCallingConfig: { mode: 'ANY' } };
    }
    return { functionCallingConfig: { mode: 'AUTO' } };
  }

  // Handle object format
  if (toolChoice.type === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }

  if (toolChoice.type === 'function' && toolChoice.function?.name) {
    // Normalize the function name
    const normalizedName = normalizeFunctionName(toolChoice.function.name);
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [normalizedName],
      },
    };
  }

  // 'auto' mode (default)
  return {
    functionCallingConfig: {
      mode: 'AUTO',
    },
  };
}

/**
 * Check if content has image parts
 */
export function hasImageContent(content: OpenAIMessageContent): boolean {
  if (typeof content === 'string') return false;
  if (Array.isArray(content)) {
    return content.some(item => item.type === 'image_url');
  }
  return false;
}

/**
 * Prepare image generation request based on model name
 * Parses resolution and aspect ratio from model name suffixes
 */
export function prepareImageGenerationRequest(
  requestBody: Record<string, any>,
  model: string
): Record<string, any> {
  const result = { ...requestBody };
  const modelLower = model.toLowerCase();
  
  // Parse resolution
  let imageSize: string | undefined;
  if (modelLower.includes('-4k')) {
    imageSize = '4K';
  } else if (modelLower.includes('-2k')) {
    imageSize = '2K';
  }
  
  // Parse aspect ratio
  let aspectRatio: string | undefined;
  const ratioMap: Record<string, string> = {
    '-21x9': '21:9',
    '-16x9': '16:9',
    '-9x16': '9:16',
    '-4x3': '4:3',
    '-3x4': '3:4',
    '-1x1': '1:1',
  };
  
  for (const [suffix, ratio] of Object.entries(ratioMap)) {
    if (modelLower.includes(suffix)) {
      aspectRatio = ratio;
      break;
    }
  }
  
  // Build imageConfig
  const imageConfig: Record<string, string> = {};
  if (aspectRatio) {
    imageConfig.aspectRatio = aspectRatio;
  }
  if (imageSize) {
    imageConfig.imageSize = imageSize;
  }
  
  // Update model name to base image model
  result.model = 'gemini-3-pro-image';
  result.generationConfig = {
    candidateCount: 1,
    imageConfig,
  };
  
  // Remove incompatible fields
  delete result.systemInstruction;
  delete result.tools;
  delete result.toolConfig;
  
  return result;
}

/**
 * Check if model is an image generation model
 */
export function isImageGenerationModel(modelName: string): boolean {
  return modelName.toLowerCase().includes('-image');
}

/**
 * Encode tool call IDs with signatures in assistant message
 * Call this before sending response back to client
 */
export function encodeToolCallIdsWithSignatures(message: any): any {
  if (!message || !message.tool_calls) {
    return message;
  }
  
  const result = { ...message };
  result.tool_calls = message.tool_calls.map((tc: any) => ({
    ...tc,
    id: encodeToolIdWithSignature(tc.id, tc.thoughtSignature),
  }));
  
  return result;
}

// ==================== Tool Call Argument Type Fixing ====================

/**
 * Fix tool call argument types based on the parameter schema.
 * Converts string values to their correct types (number, boolean, etc.)
 * 
 * This handles cases where Gemini or the client sends arguments as strings
 * when the schema expects different types.
 */
export function fixToolCallArgsTypes(
  args: Record<string, unknown>,
  parametersSchema: Record<string, unknown> | undefined,
  debugLog: boolean = false
): Record<string, unknown> {
  if (!args || !parametersSchema) {
    return args;
  }
  
  const properties = parametersSchema.properties;
  if (!properties || typeof properties !== 'object') {
    return args;
  }
  
  const fixedArgs: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties)) {
      // Parameter not in schema, keep as-is
      fixedArgs[key] = value;
      continue;
    }
    
    const paramSchema = (properties as Record<string, unknown>)[key];
    if (!paramSchema || typeof paramSchema !== 'object') {
      fixedArgs[key] = value;
      continue;
    }
    
    const paramType = (paramSchema as Record<string, unknown>).type;
    if (typeof paramType !== 'string') {
      fixedArgs[key] = value;
      continue;
    }
    
    // Apply type conversion based on schema
    const converted = convertValueToSchemaType(value, paramType, key);
    if (debugLog && converted !== value) {
      console.debug(`[fixToolCallArgsTypes] Converted ${key}: ${JSON.stringify(value)} -> ${JSON.stringify(converted)} (${paramType})`);
    }
    fixedArgs[key] = converted;
  }
  
  return fixedArgs;
}

/**
 * Convert a value to the specified schema type.
 */
function convertValueToSchemaType(
  value: unknown,
  paramType: string,
  _key: string
): unknown {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }
  
  switch (paramType) {
    case 'number':
    case 'integer':
      if (typeof value === 'string') {
        const num = paramType === 'integer' 
          ? parseInt(value, 10) 
          : parseFloat(value);
        if (!isNaN(num)) {
          return num;
        }
      } else if (typeof value === 'number') {
        return paramType === 'integer' ? Math.floor(value) : value;
      }
      return value;
      
    case 'boolean':
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true' || lower === '1' || lower === 'yes') {
          return true;
        }
        if (lower === 'false' || lower === '0' || lower === 'no') {
          return false;
        }
      }
      return value;
      
    case 'string':
      if (typeof value !== 'string') {
        return String(value);
      }
      return value;
      
    case 'array':
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            return reverseTransformArgs(parsed);
          }
        } catch {
          // Not valid JSON array
        }
      }
      if (Array.isArray(value)) {
        return reverseTransformArgs(value);
      }
      return value;
      
    case 'object':
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (typeof parsed === 'object' && parsed !== null) {
            return reverseTransformArgs(parsed as Record<string, unknown>);
          }
        } catch {
          // Not valid JSON object
        }
      }
      if (typeof value === 'object' && value !== null) {
        return reverseTransformArgs(value as Record<string, unknown>);
      }
      return value;
      
    default:
      return value;
  }
}

// ==================== Reverse Transform (Gemini string values -> native types) ====================

/**
 * Reverse transform a single value from string to native type.
 * Gemini may return all values as strings, this converts them back.
 */
export function reverseTransformValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  
  // Boolean conversion
  if (value === 'true') return true;
  if (value === 'false') return false;
  
  // Null conversion
  if (value === 'null') return null;
  
  // Number conversion (integers and floats)
  // Only convert if it looks like a pure number (no leading zeros except "0" or "-0")
  const trimmed = value.trim();
  if (trimmed && (trimmed === '0' || trimmed === '-0' || !trimmed.startsWith('0'))) {
    // Check if it's a valid integer
    if (/^-?\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num <= Number.MAX_SAFE_INTEGER && num >= Number.MIN_SAFE_INTEGER) {
        return num;
      }
    }
    // Check if it's a valid float (must have digits after decimal point)
    if (/^-?\d+\.\d+$/.test(trimmed)) {
      const num = parseFloat(trimmed);
      if (!isNaN(num) && isFinite(num)) {
        return num;
      }
    }
  }
  
  // Keep as string
  return value;
}

/**
 * Recursively reverse transform arguments from string values to native types.
 * Handles nested objects and arrays.
 */
export function reverseTransformArgs(args: unknown): unknown {
  if (args === null || args === undefined) {
    return args;
  }
  
  // Handle arrays
  if (Array.isArray(args)) {
    return args.map(item => reverseTransformArgs(item));
  }
  
  // Handle objects
  if (typeof args === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        result[key] = reverseTransformArgs(value);
      } else {
        result[key] = reverseTransformValue(value);
      }
    }
    return result;
  }
  
  // Handle primitive values
  return reverseTransformValue(args);
}

// ==================== Tool Schema Cache ====================

// Cache for tool parameter schemas (function name -> schema)
const toolSchemaCache = new Map<string, Record<string, unknown>>();

/**
 * Register tool schemas for later type fixing.
 * Call this when processing tools in a request.
 */
export function registerToolSchemas(tools: any[] | undefined): void {
  if (!tools) return;
  
  for (const tool of tools) {
    if (tool?.type === 'function' && tool.function?.name) {
      const normalizedName = normalizeFunctionName(tool.function.name);
      if (tool.function.parameters) {
        toolSchemaCache.set(normalizedName, tool.function.parameters);
      }
    }
  }
}

/**
 * Get cached tool schema by function name.
 */
export function getToolSchema(functionName: string): Record<string, unknown> | undefined {
  const normalizedName = normalizeFunctionName(functionName);
  return toolSchemaCache.get(normalizedName);
}

/**
 * Clear tool schema cache.
 * Call this at the end of a request to free memory.
 */
export function clearToolSchemaCache(): void {
  toolSchemaCache.clear();
}

// ==================== Thinking Block Validation and Sanitization ====================

/**
 * Minimum valid signature length for thinking blocks
 */
const MIN_SIGNATURE_LENGTH = 10;

/**
 * Check if a thinking block has a valid thoughtSignature
 * 
 * Valid cases:
 * 1. Empty thinking + any thoughtSignature = valid (trailing signature case)
 * 2. Has content + sufficiently long thoughtSignature = valid
 * 
 * @param block - Content block to check
 * @returns Whether the block has valid thoughtSignature
 */
export function hasValidThoughtSignature(block: Record<string, unknown>): boolean {
  if (typeof block !== 'object' || block === null) {
    return true;
  }
  
  const blockType = block.type as string;
  if (blockType !== 'thinking' && blockType !== 'redacted_thinking') {
    return true; // Non-thinking blocks are valid by default
  }
  
  const thinking = block.thinking as string || '';
  const thoughtSignature = block.thoughtSignature as string | undefined;
  
  // Empty thinking + any thoughtSignature = valid (trailing signature case)
  if (!thinking && thoughtSignature !== undefined) {
    return true;
  }
  
  // Has content + sufficiently long thoughtSignature = valid
  if (thoughtSignature && typeof thoughtSignature === 'string' && thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
    return true;
  }
  
  return false;
}

/**
 * Sanitize a thinking block by keeping only necessary fields
 * Removes extra fields like cache_control
 * 
 * @param block - Thinking block to sanitize
 * @returns Sanitized block with only essential fields
 */
export function sanitizeThinkingBlock(block: Record<string, unknown>): Record<string, unknown> {
  if (typeof block !== 'object' || block === null) {
    return block;
  }
  
  const blockType = block.type as string;
  if (blockType !== 'thinking' && blockType !== 'redacted_thinking') {
    return block;
  }
  
  // Rebuild block with only necessary fields
  const sanitized: Record<string, unknown> = {
    type: blockType,
    thinking: block.thinking || '',
  };
  
  const thoughtSignature = block.thoughtSignature as string | undefined;
  if (thoughtSignature) {
    sanitized.thoughtSignature = thoughtSignature;
  }
  
  return sanitized;
}

/**
 * Remove trailing unsigned thinking blocks from a content array
 * Modifies the array in place
 * 
 * @param blocks - Content blocks array (will be modified)
 */
export function removeTrailingUnsignedThinking(blocks: Record<string, unknown>[]): void {
  if (!blocks || blocks.length === 0) {
    return;
  }
  
  // Scan from end to beginning
  let endIndex = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (typeof block !== 'object' || block === null) {
      break;
    }
    
    const blockType = block.type as string;
    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      if (!hasValidThoughtSignature(block)) {
        endIndex = i;
      } else {
        break; // Found valid signature, stop
      }
    } else {
      break; // Found non-thinking block, stop
    }
  }
  
  if (endIndex < blocks.length) {
    blocks.splice(endIndex);
    // Log if needed: console.debug(`Removed trailing unsigned thinking block(s)`);
  }
}

/**
 * Filter invalid thinking blocks from messages and sanitize all thinking blocks
 * 
 * This function:
 * 1. Removes thinking blocks with invalid signatures (converts to text)
 * 2. Sanitizes valid thinking blocks (removes extra fields like cache_control)
 * 3. Ensures messages have valid content after filtering
 * 
 * @param messages - OpenAI messages array (will be modified)
 */
export function filterInvalidThinkingBlocks(messages: OpenAIMessage[]): void {
  let totalFiltered = 0;
  
  for (const msg of messages) {
    // Only process assistant/model messages
    if (msg.role !== 'assistant') {
      continue;
    }
    
    const content = msg.content;
    if (typeof content !== 'object' || !Array.isArray(content)) {
      continue;
    }
    
    // Process each content block
    const newBlocks: any[] = [];
    
    for (const block of content) {
      if (typeof block !== 'object' || block === null) {
        newBlocks.push(block);
        continue;
      }
      
      const blockRecord = block as unknown as Record<string, unknown>;
      const blockType = blockRecord.type as string;
      
      // Skip non-thinking blocks
      if (blockType !== 'thinking' && blockType !== 'redacted_thinking') {
        newBlocks.push(block);
        continue;
      }
      
      // All thinking blocks need sanitization (remove cache_control etc.)
      if (hasValidThoughtSignature(blockRecord)) {
        // Valid signature, sanitize and keep
        newBlocks.push(sanitizeThinkingBlock(blockRecord));
      } else {
        // Invalid signature, convert to text block
        const thinkingText = (blockRecord.thinking as string) || '';
        if (thinkingText.trim()) {
          logInfo(`[ThinkingFilter] Converting invalid thinking block to text (${thinkingText.length} chars)`);
          newBlocks.push({ type: 'text', text: thinkingText });
        }
        totalFiltered++;
      }
    }
    
    // Update message content (ensure at least one block exists)
    (msg as any).content = newBlocks.length > 0 ? newBlocks : [{ type: 'text', text: '' }];
  }
  
  if (totalFiltered > 0) {
    logWarn(`[ThinkingFilter] Filtered ${totalFiltered} invalid thinking block(s) from history`);
  }
}

/**
 * Process messages to handle thinking blocks for Gemini API
 * 
 * This is the main entry point for thinking block processing:
 * 1. Filter invalid thinking blocks (convert to text)
 * 2. Remove trailing unsigned thinking blocks
 * 
 * @param messages - OpenAI messages array
 * @returns Processed messages array
 */
export function processThinkingBlocks(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (!messages || messages.length === 0) {
    return messages;
  }
  
  // Deep clone to avoid modifying original
  const processed = messages.map(msg => ({
    ...msg,
    content: typeof msg.content === 'object' && Array.isArray(msg.content)
      ? [...msg.content]
      : msg.content,
  }));
  
  // Filter invalid thinking blocks
  filterInvalidThinkingBlocks(processed);
  
  // Remove trailing unsigned thinking blocks from last assistant message
  for (let i = processed.length - 1; i >= 0; i--) {
    const msg = processed[i];
    if (msg.role === 'assistant') {
      const content = msg.content;
      if (typeof content === 'object' && Array.isArray(content)) {
        removeTrailingUnsignedThinking(content as any[]);
      }
      break;
    }
  }
  
  return processed;
}
