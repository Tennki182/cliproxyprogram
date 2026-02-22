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

export interface ConvertOptions {
  includeThoughtSignature?: boolean;
}

/**
 * Build a map from tool_call_id to function name from assistant messages
 */
function buildToolCallIdToNameMap(messages: OpenAIMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const toolCalls = (msg as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc.id && tc.function?.name) {
            map.set(tc.id, tc.function.name);
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
          const part: any = {
            functionCall: {
              name: toolCall.function.name,
              args,
            },
          };
          if (includeThought) {
            part.thoughtSignature = 'skip_thought_signature_validator';
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
      const functionName = toolCallId ? (toolCallIdToName.get(toolCallId) || (msg as any).name) : (msg as any).name;
      
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: functionName || '',
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
 * Convert OpenAI chat completion request config to Gemini generation config
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

  // Convert reasoning_effort to thinkingConfig
  if (request.reasoning_effort !== undefined) {
    config.thinkingConfig = convertReasoningEffort(request.reasoning_effort);
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
 */
export function convertToolsToGemini(
  tools?: any[]
): GeminiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const functionDeclarations: GeminiFunctionDeclaration[] = [];
  const specialTools: any[] = [];

  for (const tool of tools) {
    if (tool.type === 'function') {
      functionDeclarations.push({
        name: tool.function.name,
        description: tool.function.description || '',
        parametersJsonSchema: cleanSchemaForGemini(tool.function.parameters),
      });
    } else if (tool.google_search) {
      // Google Search tool
      specialTools.push({ googleSearch: tool.google_search });
    } else if (tool.code_execution) {
      // Code Execution tool
      specialTools.push({ codeExecution: tool.code_execution });
    } else if (tool.url_context) {
      // URL Context tool
      specialTools.push({ urlContext: tool.url_context });
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
 * Clean JSON schema for Gemini compatibility
 */
function cleanSchemaForGemini(schema: Record<string, unknown> | undefined): any {
  // Default schema if none provided
  if (!schema || Object.keys(schema).length === 0) {
    return {
      type: 'object',
      properties: {},
    };
  }

  const cleaned = { ...schema };

  // Remove fields not supported by Gemini
  delete cleaned.$ref;
  delete cleaned.$defs;
  delete cleaned.definitions;
  delete cleaned.strict;
  delete cleaned.$schema;
  delete cleaned.additionalProperties;

  // Process properties recursively
  if (cleaned.properties && typeof cleaned.properties === 'object') {
    const newProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      cleaned.properties as Record<string, unknown>
    )) {
      newProps[key] = cleanSchemaForGemini(value as Record<string, unknown>);
    }
    cleaned.properties = newProps;
  }

  // Process items
  if (cleaned.items) {
    cleaned.items = cleanSchemaForGemini(cleaned.items as Record<string, unknown>);
  }

  // Process allOf, anyOf, oneOf - convert to plain properties
  if (cleaned.allOf) {
    return mergeAllOf(cleaned.allOf as any[]);
  }
  if (cleaned.anyOf) {
    cleaned.anyOf = (cleaned.anyOf as any[]).map(cleanSchemaForGemini);
  }
  if (cleaned.oneOf) {
    cleaned.oneOf = (cleaned.oneOf as any[]).map(cleanSchemaForGemini);
  }

  return cleaned;
}

/**
 * Merge allOf schemas
 */
function mergeAllOf(allOf: any[]): any {
  const merged: any = {
    type: 'object',
    properties: {},
    required: [],
  };

  for (const item of allOf) {
    const cleaned = cleanSchemaForGemini(item);
    if (cleaned.properties) {
      Object.assign(merged.properties, cleaned.properties);
    }
    if (cleaned.required) {
      merged.required.push(...cleaned.required);
    }
  }

  merged.required = [...new Set(merged.required)];
  return merged;
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
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.function.name],
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
