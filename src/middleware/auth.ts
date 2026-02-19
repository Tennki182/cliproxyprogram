import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '../config.js';

/**
 * Password authentication middleware
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip auth for certain paths
  const skipPaths = [
    '/',
    '/health',
    '/v1/models',
    '/auth/device',
    '/auth/status',
  ];

  if (skipPaths.some(path => request.url.startsWith(path))) {
    return;
  }

  // Check for password
  const config = getConfig();
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return reply.status(401).send({
      error: {
        message: 'Missing authorization header',
        type: 'authentication_error',
        code: 'missing_authorization',
      },
    });
  }

  // Basic auth format: "Basic base64(username:password)"
  if (authHeader.startsWith('Basic ')) {
    const base64Credentials = authHeader.slice(6);
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [, password] = credentials.split(':');

    if (password !== config.auth.password) {
      return reply.status(401).send({
        error: {
          message: 'Invalid credentials',
          type: 'authentication_error',
          code: 'invalid_credentials',
        },
      });
    }

    return;
  }

  // Bearer token format (could be API key)
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    if (token !== config.auth.password) {
      return reply.status(401).send({
        error: {
          message: 'Invalid token',
          type: 'authentication_error',
          code: 'invalid_token',
        },
      });
    }

    return;
  }

  return reply.status(401).send({
    error: {
      message: 'Invalid authorization format',
      type: 'authentication_error',
      code: 'invalid_authorization_format',
    },
  });
}

/**
 * Register auth middleware
 */
export function registerAuthMiddleware(fastify: FastifyInstance): void {
  fastify.addHook('preHandler', authMiddleware);
}
