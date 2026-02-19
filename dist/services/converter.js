/**
 * Convert OpenAI messages to Gemini contents format
 */
export function convertMessagesToContents(messages) {
    const contents = [];
    for (const msg of messages) {
        // Skip system messages - Gemini uses systemInstruction separately
        if (msg.role === 'system')
            continue;
        if (msg.role === 'user') {
            contents.push({
                role: 'user',
                parts: [{ text: msg.content }],
            });
        }
        else if (msg.role === 'assistant') {
            const parts = [];
            if (msg.content) {
                parts.push({ text: msg.content });
            }
            // Handle tool calls
            if (msg.tool_calls) {
                for (const toolCall of msg.tool_calls) {
                    parts.push({
                        functionCall: {
                            name: toolCall.function.name,
                            args: JSON.parse(toolCall.function.arguments),
                        },
                    });
                }
            }
            contents.push({
                role: 'model',
                parts: parts,
            });
        }
        else if (msg.role === 'tool') {
            contents.push({
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: msg.name || '',
                            response: { result: msg.content },
                        },
                    },
                ],
            });
        }
    }
    return contents;
}
/**
 * Extract system instruction from messages if present
 */
export function extractSystemInstruction(messages) {
    const systemMsg = messages.find((m) => m.role === 'system');
    if (!systemMsg)
        return undefined;
    return {
        role: 'user',
        parts: [{ text: systemMsg.content }],
    };
}
/**
 * Convert OpenAI chat completion request config to Gemini generation config
 */
export function convertToGeminiConfig(request) {
    const config = {};
    if (request.temperature !== undefined) {
        config.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
        config.topP = request.top_p;
    }
    if (request.max_tokens !== undefined) {
        config.maxOutputTokens = request.max_tokens;
    }
    if (request.stop !== undefined) {
        config.stopSequences = Array.isArray(request.stop)
            ? request.stop
            : [request.stop];
    }
    // Frequency and presence penalties are not directly supported in Gemini
    // but we can simulate them with temperature adjustments if needed
    return config;
}
/**
 * Convert OpenAI tools to Gemini function declarations
 */
export function convertToolsToGemini(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    const functionDeclarations = [];
    for (const tool of tools) {
        if (tool.type === 'function') {
            functionDeclarations.push({
                name: tool.function.name,
                description: tool.function.description || '',
                parameters: cleanSchemaForGemini(tool.function.parameters),
            });
        }
    }
    return [{ functionDeclarations }];
}
/**
 * Clean JSON schema for Gemini compatibility
 */
function cleanSchemaForGemini(schema) {
    const cleaned = { ...schema };
    // Remove $ref, $defs (Gemini doesn't support these)
    delete cleaned.$ref;
    delete cleaned.$defs;
    delete cleaned.definitions;
    // Process properties recursively
    if (cleaned.properties && typeof cleaned.properties === 'object') {
        const newProps = {};
        for (const [key, value] of Object.entries(cleaned.properties)) {
            newProps[key] = cleanSchemaForGemini(value);
        }
        cleaned.properties = newProps;
    }
    // Process items
    if (cleaned.items) {
        cleaned.items = cleanSchemaForGemini(cleaned.items);
    }
    // Process allOf, anyOf, oneOf - convert to plain properties
    if (cleaned.allOf) {
        return mergeAllOf(cleaned.allOf);
    }
    if (cleaned.anyOf) {
        cleaned.anyOf = cleaned.anyOf.map(cleanSchemaForGemini);
    }
    if (cleaned.oneOf) {
        cleaned.oneOf = cleaned.oneOf.map(cleanSchemaForGemini);
    }
    return cleaned;
}
/**
 * Merge allOf schemas
 */
function mergeAllOf(allOf) {
    const merged = {
        type: 'object',
        properties: {},
        required: [],
    };
    for (const item of allOf) {
        const cleaned = cleanSchemaForGemini(item);
        if (cleaned.properties) {
            Object.assign(merged.properties, cleaned.properties);
        }
        if (cleaned.required) {
            merged.required.push(...cleaned.required);
        }
    }
    merged.required = [...new Set(merged.required)];
    return merged;
}
/**
 * Convert tool choice to Gemini tool config
 */
export function convertToolChoice(toolChoice) {
    if (!toolChoice)
        return undefined;
    if (toolChoice.type === 'none') {
        return {
            functionCallingConfig: {
                mode: 'NONE',
            },
        };
    }
    if (toolChoice.type === 'function' && toolChoice.function) {
        return {
            functionCallingConfig: {
                mode: 'ANY',
                allowedFunctionNames: [toolChoice.function.name],
            },
        };
    }
    // 'auto' mode
    return {
        functionCallingConfig: {
            mode: 'AUTO',
        },
    };
}
//# sourceMappingURL=converter.js.map