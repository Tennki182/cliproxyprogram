// Gemini API Types

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiTextPart {
  text: string;
  thought?: boolean;
}

export interface GeminiInlineDataPart {
  inline_data: {
    mime_type: string;
    data: string;
  };
}

export interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

export type GeminiPart = GeminiTextPart | GeminiInlineDataPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

export interface GeminiThinkingConfig {
  thinkingBudget?: number;
  includeThoughts?: boolean;
  thinkingLevel?: 'low' | 'medium' | 'high' | 'none';
}

export interface GeminiImageConfig {
  aspectRatio?: string;
  imageSize?: string;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  candidateCount?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  thinkingConfig?: GeminiThinkingConfig;
  responseModalities?: ('TEXT' | 'IMAGE')[];
  imageConfig?: GeminiImageConfig;
  seed?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parametersJsonSchema?: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  googleSearch?: any;
  codeExecution?: any;
  urlContext?: any;
}

export interface GeminiToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'ANY' | 'NONE';
    allowedFunctionNames?: string[];
  };
}

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  generationConfig?: GeminiGenerationConfig;
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  systemInstruction?: GeminiContent;
  safetySettings?: unknown[];
}

// Loose response type — Gemini API responses vary between backends
export type GeminiResponse = any;

export interface GeminiModelInfo {
  name: string;
  version: string;
  displayName: string;
  description: string;
  supportedGenerationMethods: string[];
  inputTokenLimit: number;
  outputTokenLimit: number;
}
