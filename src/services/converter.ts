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
} from '../types/gemini.js';
import { normalizeFunctionName } from './pinyin.js';

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
  
  // Build tool_call_id -> function name mapping for tool responses
  const toolCallIdToName = buildToolCallIdToNameMap(messages);

  for (const msg of messages) {
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
          
          // Decode tool ID in case it has encoded signature from previous turn
          const { signature } = decodeToolIdAndSignature(toolCall.id);
          
          const part: any = {
            functionCall: {
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

  return contents;
}

/**
 * Extract system instruction from messages if present
 */
export function extractSystemInstruction(
  messages: OpenAIMessage[]
): GeminiContent | undefined {
  const systemMsg = messages.find((m) => m.role === 'system');
  if (!systemMsg) return undefined;

  return {
    role: 'user',
    parts: convertContentToParts(systemMsg.content),
  };
}

/**
 * Parse thinking settings from model name
 * Supports model name suffixes like -max, -high, -medium, -low, -minimal
 */
export function getThinkingSettingsFromModel(modelName: string): { thinkingBudget?: number; thinkingLevel?: string } | null {
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
    } else if (isGemini3 && isFlash) {
      return { thinkingLevel: 'high' };
    }
  }
  
  if (lowerModel.includes('-medium')) {
    if (isGemini25) {
      return { thinkingBudget: 8192 };
    } else if (isGemini3 && isFlash) {
      return { thinkingLevel: 'medium' };
    }
  }
  
  if (lowerModel.includes('-low')) {
    if (isGemini25) {
      return { thinkingBudget: 1024 };
    } else if (isGemini3 && isFlash) {
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
 * Check if model is a search model
 */
export function isSearchModel(modelName: string): boolean {
  return modelName.toLowerCase().includes('-search');
}

/**
 * Get base model name by removing feature suffixes
 */
export function getBaseModelName(modelName: string): string {
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
 */
function convertReasoningEffort(effort?: 'low' | 'medium' | 'high' | 'auto' | 'none'): GeminiThinkingConfig | undefined {
  if (!effort) return undefined;
  
  if (effort === 'auto') {
    return {
      thinkingBudget: -1,
      includeThoughts: true,
    };
  }
  
  return {
    thinkingLevel: effort === 'none' ? undefined : effort,
    includeThoughts: effort !== 'none',
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
  if (request.thinking_budget !== undefined) {
    // Direct thinking budget takes precedence
    config.thinkingConfig = {
      thinkingBudget: request.thinking_budget,
      includeThoughts: request.thinking_budget !== 0,
    };
  } else if (request.reasoning_effort !== undefined) {
    config.thinkingConfig = convertReasoningEffort(request.reasoning_effort);
  } else {
    // Parse thinking settings from model name
    const modelThinkingSettings = getThinkingSettingsFromModel(request.model);
    if (modelThinkingSettings) {
      config.thinkingConfig = {
        thinkingBudget: modelThinkingSettings.thinkingBudget,
        thinkingLevel: modelThinkingSettings.thinkingLevel as any,
        includeThoughts: true,
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
