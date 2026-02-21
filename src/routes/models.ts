import { FastifyInstance } from 'fastify';
import { OpenAIModelList, OpenAIModel } from '../types/openai.js';
import { listAllModels, resolveModelAlias, getProviderForModel, parseModelWithPrefix } from '../services/models.js';

export async function modelRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /v1/models - List available models
   */
  fastify.get<{
    Querystring: { prefix?: string; include_excluded?: string };
  }>(
    '/v1/models',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            prefix: { type: 'string' },
            include_excluded: { type: 'string' },
          },
        },
      },
    },
    async (request, _reply) => {
      const { prefix, include_excluded } = request.query;
      const includeExcluded = include_excluded === 'true';

      const allModels = listAllModels({ includeExcluded });

      const models: OpenAIModel[] = allModels.map(
        (m, index) => ({
          id: m.id,
          object: 'model' as const,
          created: 1700000000 + index,
          owned_by: m.owned_by,
          x_provider: m.provider,
          ...(m.excluded ? { x_excluded: true } : {}),
        })
      );

      // Filter by prefix if provided
      const filteredModels = prefix
        ? models.filter((m) => m.id.startsWith(prefix))
        : models;

      const response: OpenAIModelList = {
        object: 'list',
        data: filteredModels,
      };

      return response;
    }
  );

  /**
   * GET /v1/models/* - Get model information (supports provider/model prefix)
   */
  fastify.get(
    '/v1/models/*',
    async (request, reply) => {
      const id = (request.params as Record<string, string>)['*'];
      if (!id) {
        return reply.status(400).send({
          error: {
            message: 'Missing model ID',
            type: 'invalid_request_error',
            code: 'missing_model_id',
          },
        });
      }

      const parsed = parseModelWithPrefix(id);
      let providerName: string | null;
      let displayId = id;

      if (parsed) {
        providerName = parsed.provider;
      } else {
        const resolved = resolveModelAlias(id);
        providerName = getProviderForModel(resolved);
      }

      if (!providerName) {
        return reply.status(404).send({
          error: {
            message: `Model '${id}' not found`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
      }

      const owned_by = providerName === 'gemini' ? 'google'
        : providerName === 'codex' ? 'openai'
        : providerName === 'iflow' ? 'iflow'
        : 'unknown';

      const model: OpenAIModel = {
        id: displayId,
        object: 'model',
        created: 1700000000,
        owned_by,
        x_provider: providerName,
      };

      return model;
    }
  );
}
