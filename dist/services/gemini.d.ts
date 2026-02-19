import { GoogleGenerativeAI } from '@google/generative-ai';
import { GeminiGenerateContentResponse, GeminiContent, GeminiGenerationConfig, GeminiTool, GeminiToolConfig } from '../types/gemini.js';
export declare function initializeGemini(accessToken: string): void;
export declare function getGeminiClient(): GoogleGenerativeAI | null;
export declare function generateContent(modelName: string, contents: GeminiContent[], systemInstruction?: GeminiContent, generationConfig?: GeminiGenerationConfig, tools?: GeminiTool[], toolConfig?: GeminiToolConfig): Promise<GeminiGenerateContentResponse>;
export declare function generateContentStream(modelName: string, contents: GeminiContent[], systemInstruction?: GeminiContent, generationConfig?: GeminiGenerationConfig, tools?: GeminiTool[], toolConfig?: GeminiToolConfig): Promise<AsyncIterable<GeminiGenerateContentResponse>>;
export declare function isModelSupported(modelName: string): boolean;
export { ensureValidCredentials } from './auth.js';
//# sourceMappingURL=gemini.d.ts.map