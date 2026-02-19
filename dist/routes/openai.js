import { convertMessagesToContents, convertToGeminiConfig, convertToolsToGemini, convertToolChoice, extractSystemInstruction, } from '../services/converter.js';
import { generateContent, generateContentStream, isModelSupported } from '../services/gemini.js';
import { ensureValidCredentials } from '../services/auth.js';
function generateId() {
    return 'chatcmpl-' + Math.random().toString(36).substring(2, 15);
}
function getTimestamp() {
    return Math.floor(Date.now() / 1000);
}
export async function openaiRoutes(fastify) {
    /**
     * POST /v1/chat/completions - Create chat completion
     */
    fastify.post('/v1/chat/completions', {
        schema: {
            body: {
                type: 'object',
                required: ['model', 'messages'],
                properties: {
                    model: { type: 'string' },
                    messages: { type: 'array' },
                    temperature: { type: 'number' },
                    top_p: { type: 'number' },
                    max_tokens: { type: 'number' },
                    stop: { oneOf: [{ type: 'string' }, { type: 'array' }] },
                    stream: { type: 'boolean' },
                    tools: { type: 'array' },
                    tool_choice: { type: 'object' },
                    user: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const body = request.body;
        // Check if model is supported
        if (!isModelSupported(body.model)) {
            return reply.status(400).send({
                error: {
                    message: `Model '${body.model}' is not supported`,
                    type: 'invalid_request_error',
                    code: 'model_not_supported',
                },
            });
        }
        // Ensure we have valid credentials
        const credential = await ensureValidCredentials();
        if (!credential) {
            return reply.status(401).send({
                error: {
                    message: 'No valid credentials. Please authenticate first using /auth/device',
                    type: 'authentication_error',
                    code: 'not_authenticated',
                },
            });
        }
        // Convert request to Gemini format
        const contents = convertMessagesToContents(body.messages);
        const systemInstruction = extractSystemInstruction(body.messages);
        const generationConfig = convertToGeminiConfig(body);
        const tools = convertToolsToGemini(body.tools);
        const toolConfig = convertToolChoice(body.tool_choice);
        // Handle streaming
        if (body.stream) {
            const stream = await generateContentStream(body.model, contents, systemInstruction, generationConfig, tools, toolConfig);
            reply.raw.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            let chunkIndex = 0;
            const completionId = generateId();
            const timestamp = getTimestamp();
            for await (const chunk of stream) {
                const choice = {
                    index: 0,
                    delta: {
                        role: 'assistant',
                        content: null,
                    },
                    finish_reason: null,
                };
                // Extract content from chunk
                if (chunk.candidates?.[0]?.content?.parts) {
                    const textParts = chunk.candidates[0].content.parts.filter((p) => p.text);
                    if (textParts.length > 0) {
                        choice.delta.content = textParts.map((p) => p.text).join('');
                    }
                    // Handle tool calls
                    const toolCalls = chunk.candidates[0].content.parts.filter((p) => p.functionCall);
                    if (toolCalls.length > 0) {
                        choice.delta.tool_calls = toolCalls.map((tc, i) => ({
                            id: `call_${chunkIndex}_${i}`,
                            type: 'function',
                            function: {
                                name: tc.functionCall.name,
                                arguments: JSON.stringify(tc.functionCall.args),
                            },
                        }));
                    }
                }
                // Check if this is the last chunk
                if (chunk.candidates?.[0]?.finishReason && choice.delta.content) {
                    choice.finish_reason = 'stop';
                }
                const chunkResponse = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: timestamp,
                    model: body.model,
                    choices: [choice],
                };
                reply.raw.write(`data: ${JSON.stringify(chunkResponse)}\n\n`);
                chunkIndex++;
            }
            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
            return reply;
        }
        // Non-streaming request
        try {
            const response = await generateContent(body.model, contents, systemInstruction, generationConfig, tools, toolConfig);
            const choice = {
                index: 0,
                message: {
                    role: 'assistant',
                    content: '',
                },
                finish_reason: 'stop',
            };
            // Extract content from response
            if (response.candidates?.[0]?.content?.parts) {
                const textParts = response.candidates[0].content.parts.filter((p) => p.text);
                if (textParts.length > 0) {
                    choice.message.content = textParts.map((p) => p.text).join('');
                }
                // Handle tool calls
                const toolCalls = response.candidates[0].content.parts.filter((p) => p.functionCall);
                if (toolCalls.length > 0) {
                    choice.message.content = null;
                    choice.message.tool_calls = toolCalls.map((tc, i) => ({
                        id: `call_${Date.now()}_${i}`,
                        type: 'function',
                        function: {
                            name: tc.functionCall.name,
                            arguments: JSON.stringify(tc.functionCall.args),
                        },
                    }));
                    choice.finish_reason = 'tool_calls';
                }
            }
            const chatResponse = {
                id: generateId(),
                object: 'chat.completion',
                created: getTimestamp(),
                model: body.model,
                choices: [choice],
                usage: {
                    prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
                    completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
                    total_tokens: response.usageMetadata?.totalTokenCount || 0,
                },
            };
            return chatResponse;
        }
        catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({
                error: {
                    message: error.message || 'Internal server error',
                    type: 'server_error',
                },
            });
        }
    });
}
//# sourceMappingURL=openai.js.map