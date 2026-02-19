import { OpenAIMessage, OpenAITool, OpenAIToolChoice, OpenAIChatCompletionRequest } from '../types/openai.js';
import { GeminiContent, GeminiGenerationConfig, GeminiTool, GeminiToolConfig } from '../types/gemini.js';
/**
 * Convert OpenAI messages to Gemini contents format
 */
export declare function convertMessagesToContents(messages: OpenAIMessage[]): GeminiContent[];
/**
 * Extract system instruction from messages if present
 */
export declare function extractSystemInstruction(messages: OpenAIMessage[]): GeminiContent | undefined;
/**
 * Convert OpenAI chat completion request config to Gemini generation config
 */
export declare function convertToGeminiConfig(request: OpenAIChatCompletionRequest): GeminiGenerationConfig;
/**
 * Convert OpenAI tools to Gemini function declarations
 */
export declare function convertToolsToGemini(tools?: OpenAITool[]): GeminiTool[] | undefined;
/**
 * Convert tool choice to Gemini tool config
 */
export declare function convertToolChoice(toolChoice?: OpenAIToolChoice): GeminiToolConfig | undefined;
//# sourceMappingURL=converter.d.ts.map