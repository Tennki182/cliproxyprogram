import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import { getActiveCredential } from '../storage/credentials.js';
let genAI = null;
export function initializeGemini(accessToken) {
    genAI = new GoogleGenerativeAI(accessToken);
}
export function getGeminiClient() {
    return genAI;
}
export async function generateContent(modelName, contents, systemInstruction, generationConfig, tools, toolConfig) {
    if (!genAI) {
        // Try to use active credential
        const credential = getActiveCredential();
        if (credential) {
            initializeGemini(credential.access_token);
        }
        else {
            throw new Error('No Gemini credentials available. Please login first.');
        }
    }
    const model = genAI.getGenerativeModel({
        model: modelName,
        safetySettings: [
            {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold: HarmBlockThreshold.BLOCK_NONE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold: HarmBlockThreshold.BLOCK_NONE,
            },
        ],
    });
    // Build request with proper types
    const request = {
        contents: contents,
        generationConfig: generationConfig,
        tools: tools,
        toolConfig: toolConfig,
    };
    if (systemInstruction) {
        request.systemInstruction = systemInstruction;
    }
    const result = await model.generateContent(request);
    return result.response;
}
export async function generateContentStream(modelName, contents, systemInstruction, generationConfig, tools, toolConfig) {
    if (!genAI) {
        const credential = getActiveCredential();
        if (credential) {
            initializeGemini(credential.access_token);
        }
        else {
            throw new Error('No Gemini credentials available. Please login first.');
        }
    }
    const model = genAI.getGenerativeModel({
        model: modelName,
    });
    // Build request with proper types
    const request = {
        contents: contents,
        generationConfig: generationConfig,
        tools: tools,
        toolConfig: toolConfig,
    };
    if (systemInstruction) {
        request.systemInstruction = systemInstruction;
    }
    const result = await model.generateContentStream(request);
    // Convert to async iterable
    async function* streamGenerator() {
        for await (const chunk of result.stream) {
            yield chunk;
        }
    }
    return streamGenerator();
}
export function isModelSupported(modelName) {
    const supportedModels = [
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-flash',
        'gemini-1.5-pro',
        'gemini-1.5-flash-8b',
    ];
    return supportedModels.some((m) => modelName.includes(m));
}
// Export ensureValidCredentials from auth service
export { ensureValidCredentials } from './auth.js';
//# sourceMappingURL=gemini.js.map