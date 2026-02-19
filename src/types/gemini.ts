// Gemini API Types

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiTextPart {
  text: string;
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

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  candidateCount?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
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

export interface GeminiCandidate {
  content: GeminiContent;
  finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | null;
  index: number;
  safetyRatings?: unknown[];
}

export interface GeminiGenerateContentResponse {
  candidates: GeminiCandidate[];
  promptFeedback?: {
    safetyRatings?: unknown[];
  };
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export interface GeminiModelInfo {
  name: string;
  version: string;
  displayName: string;
  description: string;
  supportedGenerationMethods: string[];
  inputTokenLimit: number;
  outputTokenLimit: number;
}
