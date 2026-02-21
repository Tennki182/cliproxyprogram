import {
  OpenAIMessage,
  OpenAITool,
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
 * Convert OpenAI messages to Gemini contents format
 */
export function convertMessagesToContents(
  messages: OpenAIMessage[],
  options?: ConvertOptions
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const includeThought = options?.includeThoughtSignature ?? true;

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
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: (msg as any).name || '',
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
 * Convert OpenAI tools to Gemini function declarations
 */
export function convertToolsToGemini(
  tools?: OpenAITool[]
): GeminiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const functionDeclarations: GeminiFunctionDeclaration[] = [];

  for (const tool of tools) {
    if (tool.type === 'function') {
      functionDeclarations.push({
        name: tool.function.name,
        description: tool.function.description || '',
        parametersJsonSchema: cleanSchemaForGemini(tool.function.parameters),
      } as any);
    }
  }

  return [{ functionDeclarations }];
}

/**
 * Clean JSON schema for Gemini compatibility
 */
function cleanSchemaForGemini(schema: Record<string, unknown>): any {
  const cleaned = { ...schema };

  // Remove $ref, $defs (Gemini doesn't support these)
  delete cleaned.$ref;
  delete cleaned.$defs;
  delete cleaned.definitions;

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
