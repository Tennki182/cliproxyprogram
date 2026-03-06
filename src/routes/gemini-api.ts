import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getProviderForRequest } from '../services/provider-factory.js';
import { enqueue } from '../services/queue.js';
import { recordRequest } from './management.js';
import { logReq, logError } from '../services/log-stream.js';
import { createSSEKeepAlive } from '../services/sse-utils.js';
import { decodeToolIdAndSignature, reverseTransformArgs } from '../services/converter.js';

/**
 * Gemini-native API endpoints.
 * POST /v1beta/models/:model:generateContent
 * POST /v1beta/models/:model:streamGenerateContent
 */
export async function geminiApiRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Catch-all for /v1beta/models/* — parse model and action from the wildcard.
   * Matches URLs like: /v1beta/models/gemini-pro:generateContent
   */
  fastify.post<{ Params: { '*': string }; Body: any }>(
    '/v1beta/models/*',
    async (request: FastifyRequest<{ Params: { '*': string }; Body: any }>, reply: FastifyReply) => {
      const path = request.params['*'];
      const colonIndex = path.indexOf(':');
      if (colonIndex === -1) {
        return reply.status(400).send({ error: { message: 'Invalid path format, expected :model:action' } });
      }

      const model = path.substring(0, colonIndex);
      const action = path.substring(colonIndex + 1);

      if (action === 'generateContent') {
        return handleGenerateContent(model, request.body as any, reply);
      } else if (action === 'streamGenerateContent') {
        return handleStreamGenerateContent(model, request.body as any, reply);
      } else if (action === 'countTokens') {
        return handleCountTokens(model, request.body as any, reply);
      } else {
        return reply.status(400).send({ error: { message: `Unknown action: ${action}` } });
      }
    }
  );
}

function normalizeGeminiRequestBody(body: any): any {
  if (body?.generateContentRequest && typeof body.generateContentRequest === 'object') {
    return body.generateContentRequest;
  }
  return body || {};
}

function geminiRequestToOpenAIRequest(model: string, body: any, stream: boolean): any {
  const payload = normalizeGeminiRequestBody(body);
  const messages = geminiContentsToMessages(payload.contents, payload.systemInstruction);
  const openaiRequest: any = {
    model,
    messages,
    stream,
  };

  if (payload.generationConfig) {
    if (payload.generationConfig.temperature !== undefined) openaiRequest.temperature = payload.generationConfig.temperature;
    if (payload.generationConfig.topP !== undefined) openaiRequest.top_p = payload.generationConfig.topP;
    if (payload.generationConfig.maxOutputTokens !== undefined) openaiRequest.max_tokens = payload.generationConfig.maxOutputTokens;
    if (payload.generationConfig.topK !== undefined) openaiRequest.top_k = payload.generationConfig.topK;
    if (payload.generationConfig.seed !== undefined) openaiRequest.seed = payload.generationConfig.seed;
    if (payload.generationConfig.frequencyPenalty !== undefined) openaiRequest.frequency_penalty = payload.generationConfig.frequencyPenalty;
    if (payload.generationConfig.presencePenalty !== undefined) openaiRequest.presence_penalty = payload.generationConfig.presencePenalty;
    if (payload.generationConfig.responseMimeType !== undefined) openaiRequest.response_mime_type = payload.generationConfig.responseMimeType;
    if (payload.generationConfig.responseSchema !== undefined) openaiRequest.response_schema = payload.generationConfig.responseSchema;
  }

  if (payload.tools) {
    openaiRequest.tools = payload.tools;
  }
  if (payload.toolConfig) {
    openaiRequest.tool_choice = payload.toolConfig;
  }

  return openaiRequest;
}

async function handleGenerateContent(model: string, body: any, reply: FastifyReply) {
  let providerResult;
  try {
    providerResult = getProviderForRequest(model);
  } catch {
    return reply.status(400).send({ error: { message: `Model '${model}' not supported` } });
  }

  const { provider, resolvedModel } = providerResult;
  logReq(`Gemini req → ${provider.name}/${resolvedModel}`, { format: 'gemini', model: resolvedModel, stream: false });

  const openaiRequest = geminiRequestToOpenAIRequest(resolvedModel, body, false);

  try {
    const openaiResponse = await enqueue(() => provider.chatCompletion(resolvedModel, openaiRequest));
    recordRequest(true);
    return openaiResponseToGemini(openaiResponse);
  } catch (error: any) {
    logError(`Gemini req 失败: ${error.message}`, { model: resolvedModel });
    recordRequest(false);
    return reply.status(500).send({ error: { message: error.message } });
  }
}

async function handleStreamGenerateContent(model: string, body: any, reply: FastifyReply) {
  let providerResult;
  try {
    providerResult = getProviderForRequest(model);
  } catch {
    return reply.status(400).send({ error: { message: `Model '${model}' not supported` } });
  }

  const { provider, resolvedModel } = providerResult;
  logReq(`Gemini stream → ${provider.name}/${resolvedModel}`, { format: 'gemini', model: resolvedModel, stream: true });

  const openaiRequest = geminiRequestToOpenAIRequest(resolvedModel, body, true);

  try {
    const stream = await enqueue(() => provider.chatCompletionStream(resolvedModel, openaiRequest));

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // SSE keep-alive heartbeat
    const clearKeepAlive = createSSEKeepAlive(reply);

    try {
      for await (const chunk of stream) {
        const geminiChunk = openaiChunkToGemini(chunk);
        reply.raw.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
      }
    } finally {
      clearKeepAlive();
    }

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    recordRequest(true);
    return reply;
  } catch (error: any) {
    logError(`Gemini stream 失败: ${error.message}`, { model: resolvedModel });
    recordRequest(false);
    if (reply.raw.headersSent) {
      reply.raw.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
      reply.raw.end();
      return reply;
    }
    return reply.status(500).send({ error: { message: error.message } });
  }
}

async function handleCountTokens(model: string, body: any, reply: FastifyReply) {
  let providerResult;
  try {
    providerResult = getProviderForRequest(model);
  } catch {
    return reply.status(400).send({ error: { message: `Model '${model}' not supported` } });
  }

  const { provider, resolvedModel } = providerResult;
  logReq(`Gemini countTokens 鈫?${provider.name}/${resolvedModel}`, { format: 'gemini', model: resolvedModel, stream: false });
  const openaiRequest = geminiRequestToOpenAIRequest(resolvedModel, body, false);

  try {
    const tokenCount = await enqueue(() => provider.countTokens(resolvedModel, openaiRequest));
    recordRequest(true);
    return {
      totalTokens: tokenCount.total_tokens,
    };
  } catch (error: any) {
    logError(`Gemini countTokens 澶辫触: ${error.message}`, { model: resolvedModel });
    recordRequest(false);
    return reply.status(500).send({ error: { message: error.message } });
  }
}

/**
 * Build a tool call tracking map from messages
 * Maps normalized function names to tool call IDs
 */
function buildToolCallTrackingMap(messages: any[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.name && tc.id) {
          const normalizedName = tc.function.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
          const ids = map.get(normalizedName) || [];
          ids.push(tc.id);
          map.set(normalizedName, ids);
        }
      }
    }
  }
  
  return map;
}

/**
 * Convert Gemini contents array to OpenAI messages.
 */
function geminiContentsToMessages(contents: any[], systemInstruction?: any): any[] {
  const messages: any[] = [];

  // System instruction
  if (systemInstruction?.parts) {
    const text = systemInstruction.parts.map((p: any) => p.text || '').join('');
    if (text) messages.push({ role: 'system', content: text });
  }

  // First pass: collect all messages
  for (const c of (contents || [])) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const textParts = (c.parts || []).filter((p: any) => p.text);
    const text = textParts.map((p: any) => p.text).join('');

    if (text) {
      messages.push({ role, content: text });
    }

    // Handle function calls
    const fcParts = (c.parts || []).filter((p: any) => p.functionCall);
    if (fcParts.length > 0) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: fcParts.map((p: any, i: number) => {
          // Apply reverse transform to convert string values back to native types
          const args = reverseTransformArgs(p.functionCall.args);
          return {
            id: p.functionCall.id || `call_${messages.length}_${i}`,
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(args),
            },
          };
        }),
      });
    }

    // Handle function responses - will be processed in second pass
    const frParts = (c.parts || []).filter((p: any) => p.functionResponse);
    for (const p of frParts) {
      // Store temporarily with function name for matching
      messages.push({
        role: 'tool',
        _functionName: p.functionResponse.name,
        _toolCallId: p.functionResponse.id,
        content: JSON.stringify(p.functionResponse.response),
      });
    }
  }

  // Second pass: match tool responses to tool calls
  const toolCallMap = buildToolCallTrackingMap(messages);
  
  for (const msg of messages) {
    if (msg.role === 'tool' && msg._functionName) {
      if (msg._toolCallId) {
        msg.tool_call_id = msg._toolCallId;
        delete msg._toolCallId;
        delete msg._functionName;
        continue;
      }

      // Try to find matching tool call by normalized function name
      const normalizedName = msg._functionName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const matchedIds = toolCallMap.get(normalizedName);
      const matchedId = matchedIds?.shift();
      
      if (matchedId) {
        msg.tool_call_id = matchedId;
      } else {
        // Fallback: use a generated ID
        msg.tool_call_id = `call_${Math.random().toString(36).substring(2, 10)}`;
      }
      
      // Clean up temporary field
      delete msg._functionName;
    }
  }

  return messages;
}

/**
 * Convert OpenAI response to Gemini generateContent response format.
 */
function openaiResponseToGemini(openai: any): any {
  const choice = openai.choices?.[0];
  const parts: any[] = [];

  if (choice?.message?.content) {
    parts.push({ text: choice.message.content });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      // Decode tool ID to get original ID without encoded signature
      const { toolId: _toolId, signature } = decodeToolIdAndSignature(tc.id);
      
      // Parse arguments and apply reverse transform
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
        // Apply reverse transform to convert string values back to native types
        args = reverseTransformArgs(args) as Record<string, unknown>;
      } catch {
        args = {};
      }
      
      const part: any = {
        functionCall: {
          id: tc.id,
          name: tc.function.name,
          args,
        },
      };
      
      // Include thoughtSignature if present
      if (signature) {
        part.thoughtSignature = signature;
      }
      
      parts.push(part);
    }
  }

  return {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: choice?.finish_reason === 'tool_calls' ? 'FUNCTION_CALL' : 'STOP',
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: openai.usage?.prompt_tokens || 0,
      candidatesTokenCount: openai.usage?.completion_tokens || 0,
      totalTokenCount: openai.usage?.total_tokens || 0,
    },
  };
}

/**
 * Convert OpenAI chunk to Gemini streaming chunk format.
 */
function openaiChunkToGemini(chunk: any): any {
  const choice = chunk.choices?.[0];
  const parts: any[] = [];

  if (choice?.delta?.content) {
    parts.push({ text: choice.delta.content });
  }
  if (choice?.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(tc.function.arguments);
        // Apply reverse transform to convert string values back to native types
        args = reverseTransformArgs(parsed) as Record<string, unknown>;
      } catch {
        // Streaming chunks may have partial JSON; use empty object
        // The next chunk will have the complete arguments
        args = {};
      }
      
      // Decode tool ID to get original ID without encoded signature
      const { toolId: _toolId, signature } = decodeToolIdAndSignature(tc.id);
      
      const part: any = {
        functionCall: {
          id: tc.id,
          name: tc.function.name,
          args,
        },
      };
      
      // Include thoughtSignature if present
      if (signature) {
        part.thoughtSignature = signature;
      }
      
      parts.push(part);
    }
  }

  return {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: choice?.finish_reason === 'stop' ? 'STOP' : null,
      index: 0,
    }],
  };
}
