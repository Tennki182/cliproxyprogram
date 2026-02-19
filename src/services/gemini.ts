import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import {
  GeminiGenerateContentResponse,
  GeminiContent,
  GeminiGenerationConfig,
  GeminiTool,
  GeminiToolConfig,
} from '../types/gemini.js';
import { getActiveCredential } from '../storage/credentials.js';

let genAI: GoogleGenerativeAI | null = null;

export function initializeGemini(accessToken: string): void {
  genAI = new GoogleGenerativeAI(accessToken);
}

export function getGeminiClient(): GoogleGenerativeAI | null {
  return genAI;
}

export async function generateContent(
  modelName: string,
  contents: GeminiContent[],
  systemInstruction?: GeminiContent,
  generationConfig?: GeminiGenerationConfig,
  tools?: GeminiTool[],
  toolConfig?: GeminiToolConfig
): Promise<GeminiGenerateContentResponse> {
  if (!genAI) {
    // Try to use active credential
    const credential = getActiveCredential();
    if (credential) {
      initializeGemini(credential.access_token);
    } else {
      throw new Error('No Gemini credentials available. Please login first.');
    }
  }

  const model = genAI!.getGenerativeModel({
    model: modelName,
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
    ],
  } as any);

  // Build request with proper types
  const request: any = {
    contents: contents as any,
    generationConfig: generationConfig as any,
    tools: tools as any,
    toolConfig: toolConfig as any,
  };

  if (systemInstruction) {
    request.systemInstruction = systemInstruction as any;
  }

  const result = await model.generateContent(request as any);
  return result.response as unknown as GeminiGenerateContentResponse;
}

export async function generateContentStream(
  modelName: string,
  contents: GeminiContent[],
  systemInstruction?: GeminiContent,
  generationConfig?: GeminiGenerationConfig,
  tools?: GeminiTool[],
  toolConfig?: GeminiToolConfig
): Promise<AsyncIterable<GeminiGenerateContentResponse>> {
  if (!genAI) {
    const credential = getActiveCredential();
    if (credential) {
      initializeGemini(credential.access_token);
    } else {
      throw new Error('No Gemini credentials available. Please login first.');
    }
  }

  const model = genAI!.getGenerativeModel({
    model: modelName,
  } as any);

  // Build request with proper types
  const request: any = {
    contents: contents as any,
    generationConfig: generationConfig as any,
    tools: tools as any,
    toolConfig: toolConfig as any,
  };

  if (systemInstruction) {
    request.systemInstruction = systemInstruction as any;
  }

  const result = await model.generateContentStream(request as any);

  // Convert to async iterable
  async function* streamGenerator(): AsyncIterable<GeminiGenerateContentResponse> {
    for await (const chunk of result.stream) {
      yield chunk as unknown as GeminiGenerateContentResponse;
    }
  }

  return streamGenerator();
}

export function isModelSupported(modelName: string): boolean {
  const supportedModels = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash-8b',
  ];

  return supportedModels.some((m) => modelName.includes(m));
}

// Export ensureValidCredentials from auth service
export { ensureValidCredentials } from './auth.js';
