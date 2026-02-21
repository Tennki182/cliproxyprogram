import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getProviderForRequest } from '../services/provider-factory.js';
import { enqueue } from '../services/queue.js';
import { recordRequest } from './management.js';
import { logReq, logError } from '../services/log-stream.js';
import { createSSEKeepAlive } from '../services/sse-utils.js';

/**
 * Anthropic-compatible API endpoints.
 * POST /v1/messages — Claude Messages API format
 */
export async function anthropicRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/messages — Create a message (Claude format)
   */
  fastify.post<{ Body: any }>(
    '/v1/messages',
    async (request: FastifyRequest<{ Body: any }>, reply: FastifyReply) => {
      const body = request.body as any;
      const model = body.model;

      if (!model) {
        return reply.status(400).send({ type: 'error', error: { type: 'invalid_request_error', message: 'model is required' } });
      }

      let providerResult;
      try {
        providerResult = getProviderForRequest(model);
      } catch {
        return reply.status(400).send({
          type: 'error',
          error: { type: 'invalid_request_error', message: `Model '${model}' not supported` },
        });
      }

      const { provider, resolvedModel } = providerResult;
      const isStream = body.stream === true;
      logReq(`Anthropic ${isStream ? 'stream' : 'req'} → ${provider.name}/${resolvedModel}`, { format: 'anthropic', model: resolvedModel, stream: isStream });

      // Convert Anthropic request to OpenAI format
      const openaiMessages = anthropicToOpenAIMessages(body.system, body.messages || []);
      const openaiRequest: any = {
        model: resolvedModel,
        messages: openaiMessages,
      };
      if (body.temperature !== undefined) openaiRequest.temperature = body.temperature;
      if (body.top_p !== undefined) openaiRequest.top_p = body.top_p;
      if (body.max_tokens !== undefined) openaiRequest.max_tokens = body.max_tokens;
      if (body.stop_sequences) openaiRequest.stop = body.stop_sequences;

      // Convert Anthropic tools → OpenAI tools
      if (body.tools?.length) {
        openaiRequest.tools = body.tools.map((t: any) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters: t.input_schema || { type: 'object', properties: {} },
          },
        }));
      }

      // Convert tool_choice
      if (body.tool_choice) {
        if (body.tool_choice.type === 'auto') openaiRequest.tool_choice = 'auto';
        else if (body.tool_choice.type === 'any') openaiRequest.tool_choice = 'required';
        else if (body.tool_choice.type === 'tool') {
          openaiRequest.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
        }
      }

      if (isStream) {
        try {
          openaiRequest.stream = true;
          const stream = await enqueue(() => provider.chatCompletionStream(resolvedModel, openaiRequest));

          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const msgId = `msg_${Math.random().toString(36).substring(2, 15)}`;

          // Send message_start event
          reply.raw.write(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: msgId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: resolvedModel,
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`);

          // Send content_block_start
          reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`);

          // Keep-alive - Anthropic uses ping events
          const clearKeepAlive = createSSEKeepAlive(reply, 15000, `event: ping\ndata: {}\n\n`);

          let contentBlockIndex = 0;
          const toolCallBuffers: Map<number, { id: string; name: string; args: string }> = new Map();

          try {
            for await (const chunk of stream) {
              const choice = chunk.choices?.[0];
              const text = choice?.delta?.content;
              if (text) {
                reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text },
                })}\n\n`);
              }

              // Handle tool_call deltas
              if (choice?.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  const tcIndex = tc.index ?? 0;
                  if (!toolCallBuffers.has(tcIndex)) {
                    // New tool call — close text block, start tool_use block
                    if (contentBlockIndex === 0) {
                      reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
                        type: 'content_block_stop',
                        index: 0,
                      })}\n\n`);
                    }
                    contentBlockIndex++;
                    toolCallBuffers.set(tcIndex, {
                      id: tc.id || `toolu_${Date.now()}_${tcIndex}`,
                      name: tc.function?.name || '',
                      args: '',
                    });
                    reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: {
                        type: 'tool_use',
                        id: toolCallBuffers.get(tcIndex)!.id,
                        name: tc.function?.name || '',
                        input: {},
                      },
                    })}\n\n`);
                  }
                  // Accumulate arguments delta
                  const buf = toolCallBuffers.get(tcIndex)!;
                  if (tc.function?.arguments) {
                    buf.args += tc.function.arguments;
                    reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                      type: 'content_block_delta',
                      index: contentBlockIndex,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: tc.function.arguments,
                      },
                    })}\n\n`);
                  }
                }
              }
            }
          } finally {
            clearKeepAlive();
          }

          // Close any open tool_use blocks
          for (const [_tcIdx] of toolCallBuffers) {
            contentBlockIndex++;
            reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: contentBlockIndex - 1,
            })}\n\n`);
          }

          // If no tool calls were emitted, close the text block
          if (toolCallBuffers.size === 0) {
            reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: 0,
            })}\n\n`);
          }

          const stopReason = toolCallBuffers.size > 0 ? 'tool_use' : 'end_turn';

          // Send message_delta
          reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: stopReason },
            usage: { output_tokens: 0 },
          })}\n\n`);

          // Send message_stop
          reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({
            type: 'message_stop',
          })}\n\n`);

          reply.raw.end();
          recordRequest(true);
          return reply;
        } catch (error: any) {
          logError(`Anthropic stream 失败: ${error.message}`, { model: resolvedModel });
          recordRequest(false);
          if (reply.raw.headersSent) {
            reply.raw.write(`event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: error.message },
            })}\n\n`);
            reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            reply.raw.end();
            return reply;
          }
          return reply.status(500).send({
            type: 'error',
            error: { type: 'api_error', message: error.message },
          });
        }
      }

      // Non-streaming
      try {
        const openaiResponse = await enqueue(() => provider.chatCompletion(resolvedModel, openaiRequest));
        recordRequest(true);
        return openaiToAnthropic(resolvedModel, openaiResponse);
      } catch (error: any) {
        logError(`Anthropic req 失败: ${error.message}`, { model: resolvedModel });
        recordRequest(false);
        return reply.status(500).send({
          type: 'error',
          error: { type: 'api_error', message: error.message },
        });
      }
    }
  );
}

/**
 * Convert Anthropic messages to OpenAI messages.
 */
function anthropicToOpenAIMessages(system: string | any[] | undefined, messages: any[]): any[] {
  const result: any[] = [];

  // System message
  if (system) {
    if (typeof system === 'string') {
      result.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      const text = system.map((b: any) => b.text || '').join('\n');
      result.push({ role: 'system', content: text });
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Extract text blocks
        const text = msg.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        if (text) {
          result.push({ role: msg.role, content: text });
        }

        // Handle tool_use blocks (assistant)
        const toolUses = msg.content.filter((b: any) => b.type === 'tool_use');
        if (toolUses.length > 0) {
          result.push({
            role: 'assistant',
            content: null,
            tool_calls: toolUses.map((tu: any) => ({
              id: tu.id,
              type: 'function',
              function: {
                name: tu.name,
                arguments: JSON.stringify(tu.input),
              },
            })),
          });
        }

        // Handle tool_result blocks (user)
        const toolResults = msg.content.filter((b: any) => b.type === 'tool_result');
        for (const tr of toolResults) {
          const content = typeof tr.content === 'string'
            ? tr.content
            : (tr.content || []).map((b: any) => b.text || '').join('');
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Convert OpenAI response to Anthropic Messages API response.
 */
function openaiToAnthropic(model: string, openai: any): any {
  const choice = openai.choices?.[0];
  const content: any[] = [];

  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  const stopReason = choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';

  return {
    id: openai.id || `msg_${Math.random().toString(36).substring(2, 15)}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens || 0,
      output_tokens: openai.usage?.completion_tokens || 0,
    },
  };
}
