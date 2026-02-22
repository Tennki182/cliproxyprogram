import { FastifyInstance } from 'fastify';
import {
  createProvider,
  getProviderByName,
  getAllProviders,
  updateProvider,
  deleteProvider,
  createModel,
  getModelsByProvider,
  updateModel,
  deleteModel,
  batchCreateModels,
} from '../storage/openai-compat.js';
import { fetchModelsFromProvider } from '../services/providers/openai-compat-provider.js';

// Request/Response types
interface CreateProviderBody {
  name: string;
  baseUrl: string;
  apiKey: string;
  prefix?: string;
  headers?: Record<string, string>;
}

interface UpdateProviderBody {
  baseUrl?: string;
  apiKey?: string;
  prefix?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

interface CreateModelBody {
  modelId: string;
  alias?: string;
}

interface UpdateModelBody {
  alias?: string;
  enabled?: boolean;
}

interface FetchModelsBody {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export async function openAICompatManagementRoutes(fastify: FastifyInstance): Promise<void> {
  // ========== Provider CRUD ==========

  /**
   * GET /v0/management/openai-compat/providers - List all providers
   */
  fastify.get('/v0/management/openai-compat/providers', async (_request, reply) => {
    try {
      const providers = getAllProviders();
      // Mask API keys for security
      const maskedProviders = providers.map(p => ({
        ...p,
        apiKey: p.apiKey ? `${p.apiKey.substring(0, 8)}...${p.apiKey.substring(p.apiKey.length - 4)}` : '',
      }));
      return reply.send({ providers: maskedProviders });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  /**
   * POST /v0/management/openai-compat/providers - Create a new provider
   */
  fastify.post<{ Body: CreateProviderBody }>(
    '/v0/management/openai-compat/providers',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'baseUrl', 'apiKey'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 50 },
            baseUrl: { type: 'string', minLength: 1 },
            apiKey: { type: 'string', minLength: 1 },
            prefix: { type: 'string' },
            headers: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { name, baseUrl, apiKey, prefix, headers } = request.body;

        // Validate name (alphanumeric, hyphen, underscore only)
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          return reply.status(400).send({
            error: 'Provider 名称只能包含字母、数字、下划线和横线',
          });
        }

        // Check if provider already exists
        const existing = getProviderByName(name);
        if (existing) {
          return reply.status(409).send({
            error: `Provider '${name}' 已存在`,
          });
        }

        const provider = createProvider({
          name,
          baseUrl,
          apiKey,
          prefix,
          headers: headers || {},
          enabled: true,
        });

        return reply.status(201).send({
          provider: {
            ...provider,
            apiKey: `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`,
          },
        });
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  /**
   * GET /v0/management/openai-compat/providers/:name - Get provider details
   */
  fastify.get<{ Params: { name: string } }>(
    '/v0/management/openai-compat/providers/:name',
    async (request, reply) => {
      try {
        const { name } = request.params;
        const provider = getProviderByName(name);

        if (!provider) {
          return reply.status(404).send({ error: `Provider '${name}' 不存在` });
        }

        const models = getModelsByProvider(name);

        return reply.send({
          provider: {
            ...provider,
            apiKey: `${provider.apiKey.substring(0, 8)}...${provider.apiKey.substring(provider.apiKey.length - 4)}`,
          },
          models,
        });
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  /**
   * PATCH /v0/management/openai-compat/providers/:name - Update provider
   */
  fastify.patch<{ Params: { name: string }; Body: UpdateProviderBody }>(
    '/v0/management/openai-compat/providers/:name',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            baseUrl: { type: 'string' },
            apiKey: { type: 'string' },
            prefix: { type: 'string' },
            headers: { type: 'object' },
            enabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { name } = request.params;
        const updates = request.body;

        const provider = getProviderByName(name);
        if (!provider) {
          return reply.status(404).send({ error: `Provider '${name}' 不存在` });
        }

        const updated = updateProvider(name, updates);
        return reply.send({
          provider: updated && {
            ...updated,
            apiKey: `${updated.apiKey.substring(0, 8)}...${updated.apiKey.substring(updated.apiKey.length - 4)}`,
          },
        });
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  /**
   * DELETE /v0/management/openai-compat/providers/:name - Delete provider
   */
  fastify.delete<{ Params: { name: string } }>(
    '/v0/management/openai-compat/providers/:name',
    async (request, reply) => {
      try {
        const { name } = request.params;

        const provider = getProviderByName(name);
        if (!provider) {
          return reply.status(404).send({ error: `Provider '${name}' 不存在` });
        }

        deleteProvider(name);
        return reply.send({ success: true });
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  // ========== Model Management ==========

  /**
   * POST /v0/management/openai-compat/providers/:name/models - Add a model
   */
  fastify.post<{ Params: { name: string }; Body: CreateModelBody }>(
    '/v0/management/openai-compat/providers/:name/models',
    {
      schema: {
        body: {
          type: 'object',
          required: ['modelId'],
          properties: {
            modelId: { type: 'string', minLength: 1 },
            alias: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { name } = request.params;
        const { modelId, alias } = request.body;

        const provider = getProviderByName(name);
        if (!provider) {
          return reply.status(404).send({ error: `Provider '${name}' 不存在` });
        }

        const model = createModel({
          providerName: name,
          modelId,
          alias,
          enabled: true,
        });

        return reply.status(201).send({ model });
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  /**
   * PATCH /v0/management/openai-compat/providers/:name/models/:modelId - Update a model
   */
  fastify.patch<{ Params: { name: string; modelId: string }; Body: UpdateModelBody }>(
    '/v0/management/openai-compat/providers/:name/models/:modelId',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            alias: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { name, modelId } = request.params;
        const updates = request.body;

        const success = updateModel(name, decodeURIComponent(modelId), updates);
        if (!success) {
          return reply.status(404).send({ error: '模型不存在' });
        }

        return reply.send({ success: true });
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  /**
   * DELETE /v0/management/openai-compat/providers/:name/models/:modelId - Delete a model
   */
  fastify.delete<{ Params: { name: string; modelId: string } }>(
    '/v0/management/openai-compat/providers/:name/models/:modelId',
    async (request, reply) => {
      try {
        const { name, modelId } = request.params;

        const success = deleteModel(name, decodeURIComponent(modelId));
        if (!success) {
          return reply.status(404).send({ error: '模型不存在' });
        }

        return reply.send({ success: true });
      } catch (error: any) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  /**
   * POST /v0/management/openai-compat/fetch-models - Fetch models from upstream
   */
  fastify.post<{ Body: FetchModelsBody }>(
    '/v0/management/openai-compat/fetch-models',
    {
      schema: {
        body: {
          type: 'object',
          required: ['baseUrl', 'apiKey'],
          properties: {
            baseUrl: { type: 'string' },
            apiKey: { type: 'string' },
            headers: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { baseUrl, apiKey, headers } = request.body;

        const models = await fetchModelsFromProvider(baseUrl, apiKey, headers);

        return reply.send({
          models: models.map(m => ({
            id: m.id,
            ownedBy: m.owned_by || 'unknown',
          })),
          count: models.length,
        });
      } catch (error: any) {
        return reply.status(500).send({
          error: `拉取模型列表失败: ${error.message}`,
        });
      }
    }
  );

  /**
   * POST /v0/management/openai-compat/providers/:name/sync-models - Sync models from upstream
   */
  fastify.post<{ Params: { name: string } }>(
    '/v0/management/openai-compat/providers/:name/sync-models',
    async (request, reply) => {
      try {
        const { name } = request.params;

        const provider = getProviderByName(name);
        if (!provider) {
          return reply.status(404).send({ error: `Provider '${name}' 不存在` });
        }

        const models = await fetchModelsFromProvider(
          provider.baseUrl,
          provider.apiKey,
          provider.headers
        );

        // Convert to our model format
        const modelsToCreate = models.map(m => ({
          providerName: name,
          modelId: m.id,
          alias: '', // No alias by default
          enabled: true,
        }));

        // Batch create (ignore duplicates)
        batchCreateModels(modelsToCreate);

        return reply.send({
          synced: models.length,
          models: models.map(m => ({ id: m.id, ownedBy: m.owned_by })),
        });
      } catch (error: any) {
        return reply.status(500).send({
          error: `同步模型列表失败: ${error.message}`,
        });
      }
    }
  );
}
