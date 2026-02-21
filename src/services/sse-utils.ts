import type { FastifyReply } from 'fastify';

const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = 15000;

export function createSSEKeepAlive(
  reply: FastifyReply,
  intervalMs: number = DEFAULT_SSE_KEEPALIVE_INTERVAL_MS,
  message: string = ':\n\n'
): () => void {
  const keepAlive = setInterval(() => {
    try {
      reply.raw.write(message);
    } catch {
      clearInterval(keepAlive);
    }
  }, intervalMs);

  return () => clearInterval(keepAlive);
}
