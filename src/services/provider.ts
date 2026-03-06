/**
 * Unified provider interface.
 * All providers accept OpenAI-format requests and return OpenAI-shaped responses.
 * This abstracts away the differences between Gemini, Codex, iFlow, etc.
 */
export interface CountTokensResult {
  input_tokens: number;
  total_tokens: number;
  estimated?: boolean;
}

export interface Provider {
  readonly name: string;

  /**
   * Non-streaming chat completion.
   * Returns an OpenAI-shaped response: { id, object, choices, usage }
   */
  chatCompletion(model: string, request: any): Promise<any>;

  /**
   * Streaming chat completion.
   * Yields OpenAI-shaped chunks: { id, object, choices: [{ delta, ... }] }
   */
  chatCompletionStream(model: string, request: any): Promise<AsyncIterable<any>>;

  /**
   * Count input tokens for a request.
   * Returns a provider-agnostic token count shape.
   */
  countTokens(model: string, request: any): Promise<CountTokensResult>;

  isModelSupported(model: string): boolean;
}
