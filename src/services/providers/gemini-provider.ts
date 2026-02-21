import { Provider } from '../provider.js';
import { Backend } from '../backend.js';
import { getBackend } from '../backend-factory.js';
import {
  convertMessagesToContents,
  convertToGeminiConfig,
  convertToolsToGemini,
  convertToolChoice,
  extractSystemInstruction,
} from '../converter.js';

function generateId(): string {
  return 'chatcmpl-' + Math.random().toString(36).substring(2, 15);
}

function getTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export class GeminiProvider implements Provider {
  readonly name: string;
  private readonly backendFn: () => Backend;

  constructor(name: string = 'gemini', backendFn?: () => Backend) {
    this.name = name;
    this.backendFn = backendFn || getBackend;
  }

  async chatCompletion(model: string, request: any): Promise<any> {
    const backend = this.backendFn();

    const contents = convertMessagesToContents(request.messages, {
      includeThoughtSignature: backend.needsThoughtSignature,
    });
    const systemInstruction = extractSystemInstruction(request.messages);
    const generationConfig = convertToGeminiConfig(request);
    const tools = convertToolsToGemini(request.tools);
    const toolConfig = convertToolChoice(request.tool_choice);

    const response = await backend.generateContent(
      model, contents, systemInstruction, generationConfig, tools, toolConfig
    );

    // Convert Gemini response to OpenAI format
    return this.toOpenAIResponse(model, response);
  }

  async chatCompletionStream(model: string, request: any): Promise<AsyncIterable<any>> {
    const backend = this.backendFn();

    const contents = convertMessagesToContents(request.messages, {
      includeThoughtSignature: backend.needsThoughtSignature,
    });
    const systemInstruction = extractSystemInstruction(request.messages);
    const generationConfig = convertToGeminiConfig(request);
    const tools = convertToolsToGemini(request.tools);
    const toolConfig = convertToolChoice(request.tool_choice);

    const stream = await backend.generateContentStream(
      model, contents, systemInstruction, generationConfig, tools, toolConfig
    );

    const self = this;
    const completionId = generateId();
    const timestamp = getTimestamp();

    async function* convertStream(): AsyncIterable<any> {
      let chunkIndex = 0;
      for await (const chunk of stream) {
        yield self.toOpenAIChunk(model, chunk, completionId, timestamp, chunkIndex);
        chunkIndex++;
      }
    }

    return convertStream();
  }

  isModelSupported(model: string): boolean {
    const backend = this.backendFn();
    return backend.isModelSupported(model);
  }

  private toOpenAIResponse(model: string, response: any): any {
    const choice: any = {
      index: 0,
      message: { role: 'assistant', content: '' },
      finish_reason: 'stop',
    };

    if (response.candidates?.[0]?.content?.parts) {
      const textParts = response.candidates[0].content.parts.filter((p: any) => p.text);
      if (textParts.length > 0) {
        choice.message.content = textParts.map((p: any) => p.text).join('');
      }

      const toolCalls = response.candidates[0].content.parts.filter((p: any) => p.functionCall);
      if (toolCalls.length > 0) {
        choice.message.content = null;
        choice.message.tool_calls = toolCalls.map((tc: any, i: number) => ({
          id: `call_${Date.now()}_${i}`,
          type: 'function',
          function: {
            name: tc.functionCall.name,
            arguments: JSON.stringify(tc.functionCall.args),
          },
        }));
        choice.finish_reason = 'tool_calls';
      }
    }

    return {
      id: generateId(),
      object: 'chat.completion',
      created: getTimestamp(),
      model,
      choices: [choice],
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
        completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: response.usageMetadata?.totalTokenCount || 0,
      },
      system_fingerprint: `fp_${model.replace(/[^a-z0-9]/g, '_')}`,
    };
  }

  private toOpenAIChunk(model: string, chunk: any, id: string, created: number, index: number): any {
    const choice: any = {
      index: 0,
      delta: { role: 'assistant', content: null },
      finish_reason: null,
    };

    if (chunk.candidates?.[0]?.content?.parts) {
      const textParts = chunk.candidates[0].content.parts.filter((p: any) => p.text);
      if (textParts.length > 0) {
        choice.delta.content = textParts.map((p: any) => p.text).join('');
      }

      const toolCalls = chunk.candidates[0].content.parts.filter((p: any) => p.functionCall);
      if (toolCalls.length > 0) {
        choice.delta.tool_calls = toolCalls.map((tc: any, i: number) => ({
          id: `call_${index}_${i}`,
          type: 'function',
          function: {
            name: tc.functionCall.name,
            arguments: JSON.stringify(tc.functionCall.args),
          },
        }));
      }
    }

    if (chunk.candidates?.[0]?.finishReason) {
      choice.finish_reason = chunk.candidates[0].finishReason === 'FUNCTION_CALL' ? 'tool_calls' : 'stop';
    }

    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [choice],
    };
  }
}
