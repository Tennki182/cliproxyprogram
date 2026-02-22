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
      message: { 
        role: 'assistant', 
        content: '',
        reasoning_content: null,
      },
      finish_reason: 'stop',
    };

    if (response.candidates?.[0]?.content?.parts) {
      const parts = response.candidates[0].content.parts;
      
      // Separate text and thought parts
      const textParts: string[] = [];
      const thoughtParts: string[] = [];
      const toolCalls: any[] = [];
      
      for (const part of parts) {
        if (part.text) {
          if (part.thought) {
            thoughtParts.push(part.text);
          } else {
            textParts.push(part.text);
          }
        } else if (part.functionCall) {
          toolCalls.push({
            id: `call_${Date.now()}_${toolCalls.length}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        } else if (part.inlineData) {
          // Handle image generation response
          // This would need special handling for image data
        }
      }
      
      if (textParts.length > 0) {
        choice.message.content = textParts.join('');
      }
      
      if (thoughtParts.length > 0) {
        choice.message.reasoning_content = thoughtParts.join('');
      }

      if (toolCalls.length > 0) {
        choice.message.content = null;
        choice.message.tool_calls = toolCalls;
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
      delta: { 
        role: 'assistant', 
        content: null,
        reasoning_content: null,
      },
      finish_reason: null,
    };

    if (chunk.candidates?.[0]?.content?.parts) {
      const parts = chunk.candidates[0].content.parts;
      const textParts: string[] = [];
      const thoughtParts: string[] = [];
      const toolCalls: any[] = [];
      
      for (const part of parts) {
        if (part.text) {
          if (part.thought) {
            thoughtParts.push(part.text);
          } else {
            textParts.push(part.text);
          }
        } else if (part.functionCall) {
          toolCalls.push({
            id: `call_${index}_${toolCalls.length}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        }
      }
      
      if (textParts.length > 0) {
        choice.delta.content = textParts.join('');
      }
      
      if (thoughtParts.length > 0) {
        choice.delta.reasoning_content = thoughtParts.join('');
      }

      if (toolCalls.length > 0) {
        choice.delta.tool_calls = toolCalls;
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
