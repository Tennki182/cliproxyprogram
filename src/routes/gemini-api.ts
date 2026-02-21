import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getProviderForRequest } from '../services/provider-factory.js';
import { enqueue } from '../services/queue.js';
import { recordRequest } from './management.js';
import { logReq, logError } from '../services/log-stream.js';
import { createSSEKeepAlive } from '../services/sse-utils.js';

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
      } else {
        return reply.status(400).send({ error: { message: `Unknown action: ${action}` } });
      }
    }
  );
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

  const messages = geminiContentsToMessages(body.contents, body.systemInstruction);
  const openaiRequest: any = {
    model: resolvedModel,
    messages,
    stream: false,
  };
  if (body.generationConfig) {
    if (body.generationConfig.temperature !== undefined) openaiRequest.temperature = body.generationConfig.temperature;
    if (body.generationConfig.topP !== undefined) openaiRequest.top_p = body.generationConfig.topP;
    if (body.generationConfig.maxOutputTokens !== undefined) openaiRequest.max_tokens = body.generationConfig.maxOutputTokens;
  }

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

  const messages = geminiContentsToMessages(body.contents, body.systemInstruction);
  const openaiRequest: any = {
    model: resolvedModel,
    messages,
    stream: true,
  };
  if (body.generationConfig) {
    if (body.generationConfig.temperature !== undefined) openaiRequest.temperature = body.generationConfig.temperature;
    if (body.generationConfig.topP !== undefined) openaiRequest.top_p = body.generationConfig.topP;
    if (body.generationConfig.maxOutputTokens !== undefined) openaiRequest.max_tokens = body.generationConfig.maxOutputTokens;
  }

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
        tool_calls: fcParts.map((p: any, i: number) => ({
          id: `call_${messages.length}_${i}`,
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args),
          },
        })),
      });
    }

    // Handle function responses — match to preceding tool_calls by name
    const frParts = (c.parts || []).filter((p: any) => p.functionResponse);
    for (const p of frParts) {
      // Find the matching tool_call_id from previous assistant messages
      let matchedId = `call_0`;
      for (let mi = messages.length - 1; mi >= 0; mi--) {
        const prev = messages[mi];
        if (prev.tool_calls) {
          const match = prev.tool_calls.find((tc: any) => tc.function.name === p.functionResponse.name);
          if (match) {
            matchedId = match.id;
            break;
          }
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: matchedId,
        content: JSON.stringify(p.functionResponse.response),
      });
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
      parts.push({
        functionCall: {
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments),
        },
      });
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
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        // Streaming chunks may have partial JSON; pass as-is
        args = tc.function.arguments;
      }
      parts.push({
        functionCall: {
          name: tc.function.name,
          args,
        },
      });
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
