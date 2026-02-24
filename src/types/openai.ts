// OpenAI API Types

export interface OpenAIImageUrlPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface OpenAITextPart {
  type: 'text';
  text: string;
}

export type OpenAIMessageContent = string | (OpenAITextPart | OpenAIImageUrlPart)[];

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OpenAIMessageContent;
  name?: string;
  tool_call_id?: string;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIToolChoice {
  type: 'function' | 'none' | 'auto';
  function?: {
    name: string;
  };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  user?: string;
  // Gemini thinking/reasoning support
  reasoning_effort?: 'low' | 'medium' | 'high' | 'auto' | 'none';
  thinking_budget?: number;  // Direct thinking budget in tokens (-1 for auto)
  // Image generation support
  modalities?: ('text' | 'image')[];
  image_config?: {
    aspect_ratio?: string;
    image_size?: string;
  };
  // Additional parameters supported by Gemini
  top_k?: number;
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  response_mime_type?: string;
  response_schema?: Record<string, unknown>;
}

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  thoughtSignature?: string;  // Internal use for Gemini cloudcode-pa API
}

export interface OpenAIChatChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAIToolCall[];
    images?: any[];  // For image generation responses
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIChatCompletionChunkResponse {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
}

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  x_provider?: string;
  x_excluded?: boolean;
}

export interface OpenAIModelList {
  object: 'list';
  data: OpenAIModel[];
}
