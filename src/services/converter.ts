import {
  OpenAIMessage,
  OpenAIToolChoice,
  OpenAIChatCompletionRequest,
} from '../types/openai.js';
import {
  GeminiContent,
  GeminiGenerationConfig,
  GeminiFunctionDeclaration,
  GeminiTool,
  GeminiToolConfig,
  GeminiFunctionResponsePart,
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
        parts: [{ text: msg.content }],
      });
    } else if (msg.role === 'assistant') {
      const parts: any[] = [];

      if (msg.content) {
        parts.push({ text: msg.content });
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
    parts: [{ text: systemMsg.content }],
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

  // Frequency and presence penalties are not directly supported in Gemini
  // but we can simulate them with temperature adjustments if needed

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
export function convertToolChoice(
  toolChoice?: OpenAIToolChoice
): GeminiToolConfig | undefined {
  if (!toolChoice) return undefined;

  if (toolChoice.type === 'none') {
    return {
      functionCallingConfig: {
        mode: 'NONE',
      },
    };
  }

  if (toolChoice.type === 'function' && toolChoice.function) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.function.name],
      },
    };
  }

  // 'auto' mode
  return {
    functionCallingConfig: {
      mode: 'AUTO',
    },
  };
}
