import {
  GeminiContent,
  GeminiGenerationConfig,
  GeminiTool,
  GeminiToolConfig,
} from '../types/gemini.js';

/**
 * Abstract backend interface for Gemini API calls.
 * Implementations differ in URL format, auth, request/response envelope, and safety settings.
 */
export interface Backend {
  /** Whether function-call parts need a thoughtSignature field. */
  readonly needsThoughtSignature: boolean;

  generateContent(
    modelName: string,
    contents: GeminiContent[],
    systemInstruction?: GeminiContent,
    generationConfig?: GeminiGenerationConfig,
    tools?: GeminiTool[],
    toolConfig?: GeminiToolConfig,
  ): Promise<any>;

  generateContentStream(
    modelName: string,
    contents: GeminiContent[],
    systemInstruction?: GeminiContent,
    generationConfig?: GeminiGenerationConfig,
    tools?: GeminiTool[],
    toolConfig?: GeminiToolConfig,
  ): Promise<AsyncIterable<any>>;

  isModelSupported(modelName: string): boolean;
}
