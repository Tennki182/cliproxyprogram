import { Provider } from '../provider.js';
import { Backend } from '../backend.js';
import { getBackend } from '../backend-factory.js';
import {
  convertMessagesToContents,
  convertToGeminiConfig,
  convertToolsToGemini,
  convertToolChoice,
  extractSystemInstruction,
  encodeToolIdWithSignature,
  isImageGenerationModel,
  isSearchModel,
  prepareImageGenerationRequest,
  getBaseModelName,
} from '../converter.js';
import { resolveModelAlias } from '../models.js';
import { applyPayloadConfig } from '../payload.js';

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
    
    // Resolve model alias first, then get base model name
    // This ensures gemini-3.1-pro-high -> gemini-3.1-pro-preview -> gemini-3.1-pro-preview
    const resolvedModel = resolveModelAlias(model, this.name);
    let actualModel = getBaseModelName(resolvedModel);
    
    // Handle image generation models
    if (isImageGenerationModel(model)) {
      actualModel = 'gemini-3-pro-image';
    }

    // Apply payload configuration (default/override/filter rules)
    const processedRequest = applyPayloadConfig(model, 'openai', request);

    const contents = convertMessagesToContents(processedRequest.messages, {
      includeThoughtSignature: backend.needsThoughtSignature,
      tools: processedRequest.tools,
    });
    const systemInstruction = extractSystemInstruction(processedRequest.messages);
    let generationConfig = convertToGeminiConfig(processedRequest);
    let tools = convertToolsToGemini(processedRequest.tools);
    const toolConfig = convertToolChoice(processedRequest.tool_choice);

    // Auto-add googleSearch tool for -search models (reference: gcli2api)
    if (isSearchModel(model)) {
      if (!tools) {
        tools = [];
      }
      // Check if googleSearch is already added
      const hasGoogleSearch = tools.some((t: any) => t.googleSearch);
      if (!hasGoogleSearch) {
        tools.push({ googleSearch: {} });
      }
    }

    // Handle image generation request transformation
    if (isImageGenerationModel(model)) {
      const transformedRequest = prepareImageGenerationRequest(
        { contents, systemInstruction, generationConfig, tools, toolConfig },
        model
      );
      const response = await backend.generateContent(
        actualModel,
        transformedRequest.contents,
        transformedRequest.systemInstruction,
        transformedRequest.generationConfig,
        transformedRequest.tools,
        transformedRequest.toolConfig
      );
      return this.toOpenAIResponse(model, response, true);
    }

    const response = await backend.generateContent(
      actualModel, contents, systemInstruction, generationConfig, tools, toolConfig
    );

    // Convert Gemini response to OpenAI format
    return this.toOpenAIResponse(model, response, false, backend.needsThoughtSignature);
  }

  async chatCompletionStream(model: string, request: any): Promise<AsyncIterable<any>> {
    const backend = this.backendFn();
    
    // Resolve model alias first, then get base model name
    // This ensures gemini-3.1-pro-high -> gemini-3.1-pro-preview -> gemini-3.1-pro-preview
    const resolvedModel = resolveModelAlias(model, this.name);
    let actualModel = getBaseModelName(resolvedModel);
    
    // Handle image generation models
    if (isImageGenerationModel(model)) {
      actualModel = 'gemini-3-pro-image';
    }

    // Apply payload configuration (default/override/filter rules)
    const processedRequest = applyPayloadConfig(model, 'openai', request);

    const contents = convertMessagesToContents(processedRequest.messages, {
      includeThoughtSignature: backend.needsThoughtSignature,
      tools: processedRequest.tools,
    });
    const systemInstruction = extractSystemInstruction(processedRequest.messages);
    const generationConfig = convertToGeminiConfig(processedRequest);
    let tools = convertToolsToGemini(processedRequest.tools);
    const toolConfig = convertToolChoice(processedRequest.tool_choice);

    // Auto-add googleSearch tool for -search models (reference: gcli2api)
    if (isSearchModel(model)) {
      if (!tools) {
        tools = [];
      }
      // Check if googleSearch is already added
      const hasGoogleSearch = tools.some((t: any) => t.googleSearch);
      if (!hasGoogleSearch) {
        tools.push({ googleSearch: {} });
      }
    }

    const stream = await backend.generateContentStream(
      actualModel, contents, systemInstruction, generationConfig, tools, toolConfig
    );

    const self = this;
    const completionId = generateId();
    const timestamp = getTimestamp();
    const _isImageModel = isImageGenerationModel(model);

    async function* convertStream(): AsyncIterable<any> {
      let chunkIndex = 0;
      for await (const chunk of stream) {
        yield self.toOpenAIChunk(
          model, 
          chunk, 
          completionId, 
          timestamp, 
          chunkIndex, 
          _isImageModel,
          backend.needsThoughtSignature
        );
        chunkIndex++;
      }
    }

    return convertStream();
  }

  isModelSupported(model: string): boolean {
    const backend = this.backendFn();
    return backend.isModelSupported(getBaseModelName(model));
  }

  private toOpenAIResponse(
    model: string, 
    response: any, 
    isImageModel: boolean = false,
    _needsThoughtSignature: boolean = false
  ): any {
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
      const images: any[] = [];
      
      for (const part of parts) {
        if (part.text) {
          if (part.thought) {
            thoughtParts.push(part.text);
          } else {
            textParts.push(part.text);
          }
        } else if (part.functionCall) {
          // Encode thoughtSignature into tool_call_id if present
          const rawToolId = part.functionCall.id || `call_${Date.now()}_${toolCalls.length}`;
          const toolId = encodeToolIdWithSignature(
            rawToolId,
            part.thoughtSignature
          );
          
          toolCalls.push({
            id: toolId,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
            // Keep thoughtSignature for internal use (will be stripped by JSON.stringify if not needed)
            thoughtSignature: part.thoughtSignature,
          });
        } else if (part.inlineData && isImageModel) {
          // Handle image generation response
          images.push({
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          });
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

      // Add images to response if present
      if (images.length > 0) {
        choice.message.images = images;
      }
    }

    // Build usage object with thoughtsTokenCount (reasoning_tokens)
    const usage: any = {
      prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
      completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: response.usageMetadata?.totalTokenCount || 0,
    };
    
    // Add reasoning_tokens from thoughtsTokenCount
    const thoughtsTokenCount = response.usageMetadata?.thoughtsTokenCount || 0;
    if (thoughtsTokenCount > 0) {
      usage.completion_tokens_details = {
        reasoning_tokens: thoughtsTokenCount,
      };
    }

    return {
      id: generateId(),
      object: 'chat.completion',
      created: getTimestamp(),
      model,
      choices: [choice],
      usage,
      system_fingerprint: `fp_${model.replace(/[^a-z0-9]/g, '_')}`,
    };
  }

  private toOpenAIChunk(
    model: string, 
    chunk: any, 
    id: string, 
    created: number, 
    index: number,
    _isImageModel: boolean = false,
    _needsThoughtSignature: boolean = false
  ): any {
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
          // Encode thoughtSignature into tool_call_id if present
          const rawToolId = part.functionCall.id || `call_${index}_${toolCalls.length}`;
          const toolId = encodeToolIdWithSignature(
            rawToolId,
            part.thoughtSignature
          );
          
          toolCalls.push({
            id: toolId,
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

    // Build response object
    const response: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [choice],
    };

    // Add usage information if present in chunk
    if (chunk.usageMetadata) {
      const usage: any = {
        prompt_tokens: chunk.usageMetadata.promptTokenCount || 0,
        completion_tokens: chunk.usageMetadata.candidatesTokenCount || 0,
        total_tokens: chunk.usageMetadata.totalTokenCount || 0,
      };
      
      // Add reasoning_tokens from thoughtsTokenCount
      const thoughtsTokenCount = chunk.usageMetadata.thoughtsTokenCount || 0;
      if (thoughtsTokenCount > 0) {
        usage.completion_tokens_details = {
          reasoning_tokens: thoughtsTokenCount,
        };
      }
      
      response.usage = usage;
    }

    return response;
  }
}
