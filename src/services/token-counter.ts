/**
 * Simple token counter for local usage estimation.
 * 
 * Since we don't have tiktoken, we use approximate methods:
 * - English text: ~4 characters per token
 * - Code/structured data: ~3 characters per token
 * - Chinese text: ~1.5 characters per token
 * 
 * This is not exact but sufficient for rough usage estimation.
 */

export interface TokenCountResult {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Estimate tokens in a text string
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  
  // Count Chinese characters (each ~1 token)
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  
  // Count non-Chinese characters
  const otherChars = text.length - chineseChars;
  
  // Estimate: Chinese ~1.5 chars/token, others ~4 chars/token
  const chineseTokens = Math.ceil(chineseChars / 1.5);
  const otherTokens = Math.ceil(otherChars / 4);
  
  return chineseTokens + otherTokens;
}

/**
 * Count tokens in OpenAI-style messages
 */
export function countMessagesTokens(messages: any[]): number {
  if (!messages || messages.length === 0) return 0;
  
  let total = 0;
  
  for (const msg of messages) {
    // Base tokens per message (role + structure)
    total += 4;
    
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      // Multimodal content
      for (const item of msg.content) {
        if (item.type === 'text' && item.text) {
          total += estimateTokens(item.text);
        } else if (item.type === 'image_url') {
          // Images count as roughly 1000 tokens
          total += 1000;
        }
      }
    }
    
    // Tool calls
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += 4; // Base for tool call
        if (tc.function?.name) {
          total += estimateTokens(tc.function.name);
        }
        if (tc.function?.arguments) {
          total += estimateTokens(typeof tc.function.arguments === 'string' 
            ? tc.function.arguments 
            : JSON.stringify(tc.function.arguments));
        }
      }
    }
    
    // Tool results
    if (msg.role === 'tool' && msg.content) {
      total += estimateTokens(typeof msg.content === 'string' 
        ? msg.content 
        : JSON.stringify(msg.content));
    }
  }
  
  // Add base tokens for the conversation structure
  total += 2;
  
  return total;
}

/**
 * Count tokens in tools definitions
 */
export function countToolsTokens(tools: any[]): number {
  if (!tools || tools.length === 0) return 0;
  
  let total = 0;
  
  for (const tool of tools) {
    if (tool.type === 'function' && tool.function) {
      total += 4; // Base for tool
      if (tool.function.name) {
        total += estimateTokens(tool.function.name);
      }
      if (tool.function.description) {
        total += estimateTokens(tool.function.description);
      }
      if (tool.function.parameters) {
        total += estimateTokens(JSON.stringify(tool.function.parameters));
      }
    }
  }
  
  return total;
}

/**
 * Count input tokens for a request without estimating any output tokens.
 */
export function countRequestInputTokens(request: any): number {
  return countMessagesTokens(request?.messages || [])
    + countToolsTokens(request?.tools || []);
}

/**
 * Calculate token count for a complete request
 */
export function calculateRequestTokens(request: any): TokenCountResult {
  const promptTokens = countRequestInputTokens(request);
  
  // Estimate completion tokens based on max_tokens or default
  const completionTokens = request.max_tokens || 1000;
  
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/**
 * Parse usage from streaming response chunk
 */
export function parseStreamUsage(chunk: any): Partial<TokenCountResult> | null {
  if (!chunk) return null;
  
  // Try to extract usage from various formats
  if (chunk.usage) {
    return {
      prompt_tokens: chunk.usage.prompt_tokens,
      completion_tokens: chunk.usage.completion_tokens,
      total_tokens: chunk.usage.total_tokens,
    };
  }
  
  // Check for x-usage header or similar
  if (chunk.x_usage) {
    return {
      prompt_tokens: chunk.x_usage.prompt_tokens,
      completion_tokens: chunk.x_usage.completion_tokens,
      total_tokens: chunk.x_usage.total_tokens,
    };
  }
  
  return null;
}
