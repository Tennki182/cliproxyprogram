import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
/**
 * Password authentication middleware
 */
export declare function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void>;
/**
 * Register auth middleware
 */
export declare function registerAuthMiddleware(fastify: FastifyInstance): void;
//# sourceMappingURL=auth.d.ts.map