import { generateDeviceCode, pollForToken, getCredentialStatus, refreshAccessToken } from '../services/auth.js';
import { listCredentials, deleteCredential, getActiveCredential } from '../storage/credentials.js';
import { getAccountSessions, deleteSession } from '../storage/sessions.js';
export async function authRoutes(fastify) {
    // Store pending device codes
    const pendingCodes = new Map();
    /**
     * POST /auth/device - Start device authorization flow
     */
    fastify.post('/auth/device', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    interval: { type: 'number', default: 5 },
                    timeout: { type: 'number', default: 120 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { interval = 5, timeout = 120 } = request.body;
            const result = await generateDeviceCode();
            pendingCodes.set(result.device_code, {
                deviceCode: result.device_code,
                interval,
            });
            // Auto-cleanup after timeout
            setTimeout(() => {
                pendingCodes.delete(result.device_code);
            }, timeout * 1000);
            return {
                device_code: result.device_code,
                user_code: result.user_code,
                verification_url: result.verification_url,
                expires_in: result.expires_in,
                interval: result.interval,
                message: 'Please visit the verification URL and enter the user code',
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: error.message });
        }
    });
    /**
     * POST /auth/poll - Poll for token after user authorization
     */
    fastify.post('/auth/poll', {
        schema: {
            body: {
                type: 'object',
                required: ['device_code'],
                properties: {
                    device_code: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { device_code } = request.body;
        const pending = pendingCodes.get(device_code);
        if (!pending) {
            return reply.status(400).send({ error: 'Invalid or expired device code' });
        }
        try {
            const credential = await pollForToken(device_code, pending.interval);
            pendingCodes.delete(device_code);
            return {
                success: true,
                account_id: credential.account_id,
                message: 'Authorization successful',
            };
        }
        catch (error) {
            if (error.message.includes('timed out')) {
                return reply.status(408).send({ error: error.message });
            }
            // Return pending status for other errors
            return {
                success: false,
                pending: true,
                error: error.message,
            };
        }
    });
    /**
     * GET /auth/status - Get current credential status
     */
    fastify.get('/auth/status', async (_request, _reply) => {
        const status = getCredentialStatus();
        return status;
    });
    /**
     * POST /auth/refresh - Refresh current credentials
     */
    fastify.post('/auth/refresh', async (_request, reply) => {
        const credential = getActiveCredential();
        if (!credential || !credential.refresh_token) {
            return reply.status(400).send({ error: 'No refresh token available' });
        }
        try {
            const newCredential = await refreshAccessToken(credential.refresh_token);
            return {
                success: true,
                account_id: newCredential.account_id,
            };
        }
        catch (error) {
            return reply.status(500).send({ error: error.message });
        }
    });
    /**
     * GET /auth/accounts - List all accounts
     */
    fastify.get('/auth/accounts', async (_request, _reply) => {
        const credentials = listCredentials();
        return {
            accounts: credentials.map(c => ({
                account_id: c.account_id,
                expires_at: c.expires_at,
                has_refresh_token: !!c.refresh_token,
            })),
        };
    });
    /**
     * DELETE /auth/accounts/:accountId - Delete an account
     */
    fastify.delete('/auth/accounts/:accountId', {
        schema: {
            params: {
                type: 'object',
                required: ['accountId'],
                properties: {
                    accountId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { accountId } = request.params;
        try {
            deleteCredential(accountId);
            return { success: true, message: `Account ${accountId} deleted` };
        }
        catch (error) {
            return reply.status(500).send({ error: error.message });
        }
    });
    /**
     * GET /auth/sessions - List sessions for current account
     */
    fastify.get('/auth/sessions', async (_request, _reply) => {
        const credential = getActiveCredential();
        if (!credential) {
            return { sessions: [] };
        }
        const sessions = getAccountSessions(credential.account_id);
        return {
            sessions: sessions.map(s => ({
                session_id: s.session_id,
                message_count: JSON.parse(s.messages || '[]').length,
                updated_at: s.updated_at,
            })),
        };
    });
    /**
     * DELETE /auth/sessions/:sessionId - Delete a session
     */
    fastify.delete('/auth/sessions/:sessionId', {
        schema: {
            params: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        try {
            deleteSession(sessionId);
            return { success: true, message: `Session ${sessionId} deleted` };
        }
        catch (error) {
            return reply.status(500).send({ error: error.message });
        }
    });
}
//# sourceMappingURL=auth.js.map