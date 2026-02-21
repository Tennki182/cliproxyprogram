import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'fs';
import { loadConfig, getConfig } from './config.js';
import { openaiRoutes } from './routes/openai.js';
import { modelRoutes } from './routes/models.js';
import { authRoutes } from './routes/auth.js';
import { codexAuthRoutes } from './routes/auth-codex.js';
import { iflowAuthRoutes } from './routes/auth-iflow.js';
import { geminiApiRoutes } from './routes/gemini-api.js';
import { anthropicRoutes } from './routes/anthropic.js';
import { managementRoutes } from './routes/management.js';
import { initDatabase, closeDatabase } from './storage/db.js';
import { registerAuthMiddleware } from './middleware/auth.js';
import { startConfigWatcher, stopConfigWatcher } from './services/config-watcher.js';
import { startTokenRefresher, stopTokenRefresher } from './services/token-refresher.js';
import { join } from 'path';

export async function createServer(): Promise<FastifyInstance> {
  const config = loadConfig();

  // TLS options
  const httpsOptions = config.tls.enabled && config.tls.cert && config.tls.key
    ? {
        https: {
          cert: readFileSync(config.tls.cert),
          key: readFileSync(config.tls.key),
        },
      }
    : {};

  const fastify = Fastify({
    logger: {
      level: config.logging.level,
    },
    ...httpsOptions,
  });

  // Register plugins
  await fastify.register(cors, {
    origin: true,
    credentials: false,
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
  await fastify.register(codexAuthRoutes);
  await fastify.register(iflowAuthRoutes);
  await fastify.register(geminiApiRoutes);
  await fastify.register(anthropicRoutes);
  await fastify.register(managementRoutes);

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

  const config = getConfig();

  // Start config file watcher for hot-reload
  startConfigWatcher();

  // Start background token refresher
  startTokenRefresher();

  // Handle shutdown
  const shutdown = async () => {
    stopTokenRefresher();
    stopConfigWatcher();
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

    const protocol = config.tls.enabled ? 'https' : 'http';
    server.log.info(`Server listening on ${config.server.host}:${config.server.port}`);
    server.log.info(`Admin panel available at ${protocol}://localhost:${config.server.port}/`);

    const { logInfo } = await import('./services/log-stream.js');
    logInfo(`服务启动 — ${protocol}://${config.server.host}:${config.server.port}`);
    if (config.tls.enabled) {
      server.log.info('TLS enabled');
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}
