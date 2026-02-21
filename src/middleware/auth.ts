import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '../config.js';

/** Routes that require no auth at all */
const NO_AUTH_PATHS = [
  '/health',
  '/auth/login',
  '/auth/callback',
  '/auth/codex/login',
  '/auth/codex/callback',
  '/auth/iflow/login',
  '/auth/iflow/callback',
  '/auth/verify',
];

/** Check if the path is an API route (clients calling the proxy) */
function isApiRoute(path: string): boolean {
  if (path.startsWith('/v1beta/')) return true;
  if (path.startsWith('/v1/')) return true;
  return false;
}

/**
 * Extract auth token from the request.
 * Supports:
 *   - Authorization: Bearer <token>      (OpenAI / general)
 *   - Authorization: Basic <base64>      (user:password → extracts password)
 *   - x-api-key: <token>                 (Anthropic / Claude Code)
 *   - ?key=<token>                       (Gemini SDK)
 */
function extractToken(request: FastifyRequest): string | null {
  // 1. x-api-key header (Anthropic SDK / Claude Code)
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey) return xApiKey;

  // 2. Authorization header
  const authHeader = request.headers.authorization;
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    if (authHeader.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
      const colonIndex = decoded.indexOf(':');
      if (colonIndex !== -1) return decoded.slice(colonIndex + 1);
    }
  }

  // 3. ?key= query parameter (Gemini SDK)
  const url = new URL(request.url, 'http://localhost');
  const keyParam = url.searchParams.get('key');
  if (keyParam) return keyParam;

  return null;
}

function sendUnauthorized(reply: FastifyReply, message: string, code: string): void {
  reply.status(401).send({
    error: { message, type: 'authentication_error', code },
  });
}

/**
 * Authentication middleware — supports all three API formats.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const urlPath = request.url.split('?')[0];

  // No auth needed
  if (NO_AUTH_PATHS.some(p => p === urlPath || (p !== '/' && urlPath.startsWith(p + '/')))) return;
  if (urlPath === '/') return;
  if (urlPath.startsWith('/admin')) return;
  if (urlPath.startsWith('/v0/management')) return; // management routes have their own auth

  const config = getConfig();
  const token = extractToken(request);

  if (isApiRoute(urlPath)) {
    // API routes — check apiKey (empty apiKey = no auth required)
    if (!config.auth.apiKey) return;
    if (!token) {
      return sendUnauthorized(reply, 'Missing authentication', 'missing_authorization');
    }
    if (token !== config.auth.apiKey) {
      return sendUnauthorized(reply, 'Invalid API key', 'invalid_api_key');
    }
  } else {
    // Admin/auth routes — check loginSecret (empty loginSecret = no auth required)
    if (!config.auth.loginSecret) return;
    if (!token) {
      return sendUnauthorized(reply, 'Missing authentication', 'missing_authorization');
    }
    if (token !== config.auth.loginSecret) {
      return sendUnauthorized(reply, 'Invalid login secret', 'invalid_secret');
    }
  }
}

/**
 * Register auth middleware
 */
export function registerAuthMiddleware(fastify: FastifyInstance): void {
  fastify.addHook('preHandler', authMiddleware);
}
