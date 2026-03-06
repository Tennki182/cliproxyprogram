import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { OpenAIChatCompletionRequest } from '../types/openai.js';
import { getProviderForRequest } from '../services/provider-factory.js';
import { enqueue } from '../services/queue.js';
import { recordRequest } from './management.js';
import { recordUsage } from '../services/usage.js';
import { logReq, logError } from '../services/log-stream.js';
import { createSSEKeepAlive } from '../services/sse-utils.js';
import { acquireCredential } from '../services/rotation.js';

export async function openaiRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/chat/completions - Create chat completion
   */
  fastify.post<{ Body: OpenAIChatCompletionRequest }>(
    '/v1/chat/completions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['model', 'messages'],
          // Allow additional properties to pass through to the handler
          // SillyTavern and other clients may send extra parameters like
          // reasoning_effort, thinking_budget, response_format, etc.
          additionalProperties: true,
          properties: {
            model: { type: 'string' },
            messages: { type: 'array' },
            temperature: { type: 'number' },
            top_p: { type: 'number' },
            max_tokens: { type: 'number' },
            max_completion_tokens: { type: 'number' },
            stop: { oneOf: [{ type: 'string' }, { type: 'array' }] },
            stream: { type: 'boolean' },
            tools: { type: 'array' },
            tool_choice: {},
            user: { type: 'string' },
            // Additional parameters for Gemini thinking/reasoning
            reasoning_effort: { type: 'string' },
            thinking_budget: { type: 'number' },
            // Additional parameters supported by Gemini
            top_k: { type: 'number' },
            seed: { type: 'number' },
            frequency_penalty: { type: 'number' },
            presence_penalty: { type: 'number' },
            response_format: { type: 'object' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: OpenAIChatCompletionRequest }>, reply: FastifyReply) => {
      const body = request.body;

      // Find provider
      let providerResult;
      try {
        providerResult = getProviderForRequest(body.model);
      } catch {
        return reply.status(400).send({
          error: {
            message: `Model '${body.model}' is not supported by any provider`,
            type: 'invalid_request_error',
            code: 'model_not_supported',
          },
        });
      }

      const { provider, resolvedModel: model } = providerResult;
      const isStream = body.stream;
      logReq(`OpenAI ${isStream ? 'stream' : 'req'} → ${provider.name}/${model}`, { format: 'openai', model, stream: isStream });

      // Get credential for usage tracking
      const credential = await acquireCredential({ provider: provider.name, modelName: model });

      // Handle streaming
      if (isStream) {
        try {
          const stream = await enqueue(() => provider.chatCompletionStream(model, body));

          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const clearKeepAlive = createSSEKeepAlive(reply);

          // Track usage for streaming
          let inputTokens = 0;
          let outputTokens = 0;
          let hasError = false;

          try {
            for await (const chunk of stream) {
              reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);

              // Extract usage from chunk if available
              if (chunk.usage) {
                inputTokens = chunk.usage.prompt_tokens || inputTokens;
                outputTokens = chunk.usage.completion_tokens || outputTokens;
              }
            }
          } finally {
            clearKeepAlive();
          }

          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();

          // Record usage
          if (credential) {
            recordUsage(credential, model, {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            }, !hasError);
          }

          recordRequest(true);
          return reply;
        } catch (error: any) {
          fastify.log.error(error);
          recordRequest(false);

          // Record failed usage
          if (credential) {
            recordUsage(credential, model, {}, false, error.message);
          }

          logError(`OpenAI stream 失败: ${error.message}`, { model });
          // If headers already sent, can't reply with JSON
          if (reply.raw.headersSent) {
            reply.raw.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
            reply.raw.end();
            return reply;
          }
          return reply.status(500).send({
            error: { message: error.message || 'Internal server error', type: 'server_error' },
          });
        }
      }

      // Non-streaming request
      try {
        const response = await enqueue(() => provider.chatCompletion(model, body));
        recordRequest(true);

        // Record usage from response
        if (credential && response) {
          const usage = response.usage || {};
          recordUsage(credential, model, {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }, true);
        }

        return reply.send(response);
      } catch (error: any) {
        fastify.log.error(error);
        recordRequest(false);

        // Record failed usage
        if (credential) {
          recordUsage(credential, model, {}, false, error.message);
        }

        logError(`OpenAI req 失败: ${error.message}`, { model });
        return reply.status(500).send({
          error: {
            message: error.message || 'Internal server error',
            type: 'server_error',
          },
        });
      }
    }
  );
}
