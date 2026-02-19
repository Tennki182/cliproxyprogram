import { FastifyInstance } from 'fastify';
import { OpenAIModelList, OpenAIModel } from '../types/openai.js';
import { getConfig } from '../config.js';

export async function modelRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /v1/models - List available models
   */
  fastify.get<{
    Querystring: { prefix?: string };
  }>(
    '/v1/models',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            prefix: { type: 'string' },
          },
        },
      },
    },
    async (request, _reply) => {
      const config = getConfig();
      const { prefix } = request.query;

      const models: OpenAIModel[] = config.gemini.supportedModels.map(
        (modelName, index) => ({
          id: modelName,
          object: 'model',
          created: 1700000000 + index,
          owned_by: 'google',
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
   * GET /v1/models/:id - Get model information
   */
  fastify.get<{
    Params: { id: string };
  }>(
    '/v1/models/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const config = getConfig();
      const { id } = request.params;

      if (!config.gemini.supportedModels.includes(id)) {
        return reply.status(404).send({
          error: {
            message: `Model '${id}' not found`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
      }

      const modelIndex = config.gemini.supportedModels.indexOf(id);
      const model: OpenAIModel = {
        id,
        object: 'model',
        created: 1700000000 + modelIndex,
        owned_by: 'google',
      };

      return model;
    }
  );
}
