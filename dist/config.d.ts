import { z } from 'zod';
declare const ConfigSchema: z.ZodObject<{
    server: z.ZodObject<{
        host: z.ZodString;
        port: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        host: string;
        port: number;
    }, {
        host: string;
        port: number;
    }>;
    auth: z.ZodObject<{
        password: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        password: string;
    }, {
        password: string;
    }>;
    storage: z.ZodObject<{
        type: z.ZodString;
        path: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        path: string;
        type: string;
    }, {
        path: string;
        type: string;
    }>;
    gemini: z.ZodObject<{
        defaultModel: z.ZodString;
        supportedModels: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        defaultModel: string;
        supportedModels: string[];
    }, {
        defaultModel: string;
        supportedModels: string[];
    }>;
    oauth: z.ZodObject<{
        clientId: z.ZodString;
        clientSecret: z.ZodString;
        redirectUri: z.ZodString;
        scopes: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
        scopes: string[];
    }, {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
        scopes: string[];
    }>;
    apiKey: z.ZodOptional<z.ZodString>;
    logging: z.ZodObject<{
        level: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        level: string;
    }, {
        level: string;
    }>;
}, "strip", z.ZodTypeAny, {
    server: {
        host: string;
        port: number;
    };
    auth: {
        password: string;
    };
    storage: {
        path: string;
        type: string;
    };
    gemini: {
        defaultModel: string;
        supportedModels: string[];
    };
    oauth: {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
        scopes: string[];
    };
    logging: {
        level: string;
    };
    apiKey?: string | undefined;
}, {
    server: {
        host: string;
        port: number;
    };
    auth: {
        password: string;
    };
    storage: {
        path: string;
        type: string;
    };
    gemini: {
        defaultModel: string;
        supportedModels: string[];
    };
    oauth: {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
        scopes: string[];
    };
    logging: {
        level: string;
    };
    apiKey?: string | undefined;
}>;
export type Config = z.infer<typeof ConfigSchema>;
export declare function loadConfig(path?: string): Config;
export declare function getConfig(): Config;
export {};
//# sourceMappingURL=config.d.ts.map