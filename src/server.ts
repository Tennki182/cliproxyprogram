import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { openaiRoutes } from './routes/openai.js';
import { modelRoutes } from './routes/models.js';
import { authRoutes } from './routes/auth.js';
import { initDatabase, closeDatabase } from './storage/db.js';
import { registerAuthMiddleware } from './middleware/auth.js';
import { join } from 'path';

export async function createServer(): Promise<FastifyInstance> {
  const config = loadConfig();

  const fastify = Fastify({
    logger: {
      level: config.logging.level,
    },
  });

  // Register plugins
  await fastify.register(cors, {
    origin: true,
  });

  await fastify.register(formbody);

  // Register static file serving for admin panel
  await fastify.register(fastifyStatic, {
    root: join(process.cwd(), 'public'),
    prefix: '/admin/',
    index: 'index.html',
  });

  // Register auth middleware
  registerAuthMiddleware(fastify);

  // Register routes
  await fastify.register(openaiRoutes);
  await fastify.register(modelRoutes);
  await fastify.register(authRoutes);

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok' };
  });

  // Root route - serve admin panel
  fastify.get('/', async (_request, reply) => {
    return reply.sendFile('index.html');
  });

  return fastify;
}

export async function startServer(): Promise<void> {
  // Initialize database
  await initDatabase();

  const server = await createServer();

  const config = loadConfig();

  // Handle shutdown
  const shutdown = async () => {
    await server.close();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.listen({
      host: config.server.host,
      port: config.server.port,
    });

    server.log.info(`Server listening on ${config.server.host}:${config.server.port}`);
    server.log.info(`Admin panel available at http://localhost:${config.server.port}/`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}
