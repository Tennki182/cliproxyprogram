import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';

// Default OAuth credentials (can be overridden in config.yaml)
const DEFAULT_GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const DEFAULT_GEMINI_CLIENT_SECRET = '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';
const DEFAULT_GEMINI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CODEX_AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
const DEFAULT_CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const DEFAULT_CODEX_API_BASE = 'https://chatgpt.com/backend-api/codex';

const DEFAULT_IFLOW_CLIENT_ID = '10009311001';
const DEFAULT_IFLOW_CLIENT_SECRET = '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW';
const DEFAULT_IFLOW_AUTH_ENDPOINT = 'https://iflow.cn/oauth';
const DEFAULT_IFLOW_TOKEN_ENDPOINT = 'https://iflow.cn/oauth/token';
const DEFAULT_IFLOW_USERINFO_ENDPOINT = 'https://iflow.cn/api/oauth/getUserInfo';
const DEFAULT_IFLOW_API_BASE = 'https://apis.iflow.cn/v1';

// OAuth configuration schema
const OAuthProvidersSchema = z.object({
  gemini: z.object({
    clientId: z.string().default(DEFAULT_GEMINI_CLIENT_ID),
    clientSecret: z.string().default(DEFAULT_GEMINI_CLIENT_SECRET),
    scopes: z.array(z.string()).default(DEFAULT_GEMINI_SCOPES),
  }).default({}),
  codex: z.object({
    clientId: z.string().default(DEFAULT_CODEX_CLIENT_ID),
    authEndpoint: z.string().default(DEFAULT_CODEX_AUTH_ENDPOINT),
    tokenEndpoint: z.string().default(DEFAULT_CODEX_TOKEN_ENDPOINT),
    apiBase: z.string().default(DEFAULT_CODEX_API_BASE),
  }).default({}),
  iflow: z.object({
    clientId: z.string().default(DEFAULT_IFLOW_CLIENT_ID),
    clientSecret: z.string().default(DEFAULT_IFLOW_CLIENT_SECRET),
    authEndpoint: z.string().default(DEFAULT_IFLOW_AUTH_ENDPOINT),
    tokenEndpoint: z.string().default(DEFAULT_IFLOW_TOKEN_ENDPOINT),
    userinfoEndpoint: z.string().default(DEFAULT_IFLOW_USERINFO_ENDPOINT),
    apiBase: z.string().default(DEFAULT_IFLOW_API_BASE),
  }).default({}),
}).default({});

// OAuth model alias schema
const OAuthModelAliasEntrySchema = z.object({
  name: z.string(),
  alias: z.string(),
  fork: z.boolean().default(false),
});

const OAuthModelAliasSchema = z.record(z.string(), z.array(OAuthModelAliasEntrySchema)).default({});

// OAuth excluded models schema
const OAuthExcludedModelsSchema = z.record(z.string(), z.array(z.string())).default({});

// Payload configuration schema
const PayloadRuleSchema = z.object({
  models: z.array(z.object({
    name: z.string(),
    protocol: z.string().optional(),
  })),
  params: z.record(z.string(), z.any()),
});

const PayloadConfigSchema = z.object({
  default: z.array(PayloadRuleSchema).default([]),
  defaultRaw: z.array(PayloadRuleSchema).default([]),
  override: z.array(PayloadRuleSchema).default([]),
  overrideRaw: z.array(PayloadRuleSchema).default([]),
  filter: z.array(z.object({
    models: z.array(z.object({
      name: z.string(),
      protocol: z.string().optional(),
    })),
    params: z.array(z.string()),
  })).default([]),
}).default({});

const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().default(8488),
  }).default({}),
  auth: z.preprocess((val: any) => {
    if (typeof val === 'object' && val) {
      return {
        apiKey: val.apiKey ?? val.password ?? 'password',
        loginSecret: val.loginSecret ?? val.password ?? 'password',
      };
    }
    return { apiKey: 'password', loginSecret: 'password' };
  }, z.object({
    apiKey: z.string(),
    loginSecret: z.string(),
  })),
  storage: z.object({
    type: z.string(),
    path: z.string(),
  }),
  oauth: OAuthProvidersSchema,
  oauthModelAlias: OAuthModelAliasSchema,
  oauthExcludedModels: OAuthExcludedModelsSchema,
  gemini: z.object({
    defaultModel: z.string(),
    apiEndpoint: z.string().default('https://cloudcode-pa.googleapis.com/v1internal'),
    supportedModels: z.array(z.string()),
    backend: z.enum(['cloudcode', 'public']).default('cloudcode'),
    apiKey: z.string().optional(),
    modelAliases: z.record(z.string(), z.string()).default({}),
    excludedModels: z.array(z.string()).default([]),
  }),
  codex: z.object({
    enabled: z.boolean().default(false),
    supportedModels: z.array(z.string()).default([]),
    modelAliases: z.record(z.string(), z.string()).default({}),
    excludedModels: z.array(z.string()).default([]),
  }).default({}),
  iflow: z.object({
    enabled: z.boolean().default(false),
    supportedModels: z.array(z.string()).default([]),
    modelAliases: z.record(z.string(), z.string()).default({}),
    excludedModels: z.array(z.string()).default([]),
  }).default({}),
  qwen: z.object({
    enabled: z.boolean().default(false),
    supportedModels: z.array(z.string()).default([]),
    modelAliases: z.record(z.string(), z.string()).default({}),
    excludedModels: z.array(z.string()).default([]),
  }).default({}),
  kimi: z.object({
    enabled: z.boolean().default(false),
    supportedModels: z.array(z.string()).default([]),
    modelAliases: z.record(z.string(), z.string()).default({}),
    excludedModels: z.array(z.string()).default([]),
  }).default({}),
  routing: z.object({
    strategy: z.enum(['round-robin', 'fill-first']).default('round-robin'),
  }).default({}),
  retry: z.object({
    maxRetries: z.number().default(3),
    backoffMultiplier: z.number().default(2),
    maxIntervalMs: z.number().default(30000),
    baseIntervalMs: z.number().default(5000),
  }).default({}),
  management: z.object({
    enabled: z.boolean().default(true),
    secret: z.string().default(''),
  }).default({}),
  tls: z.object({
    enabled: z.boolean().default(false),
    cert: z.string().default(''),
    key: z.string().default(''),
  }).default({}),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  }).default({}),
  proxy: z.string().optional(),
  queue: z.object({
    concurrency: z.number().default(5),
  }).default({}),
  payload: PayloadConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

let config: Config | null = null;
let configPath: string = './config.yaml';

export function loadConfig(path: string = './config.yaml'): Config {
  configPath = path;
  const fileContent = readFileSync(path, 'utf-8');
  const parsed = parse(fileContent);
  config = ConfigSchema.parse(parsed);
  return config;
}

/**
 * Reload config from disk (for hot-reload).
 * Returns the new config, or null if parsing fails.
 */
export function reloadConfig(): Config | null {
  try {
    const fileContent = readFileSync(configPath, 'utf-8');
    const parsed = parse(fileContent);
    config = ConfigSchema.parse(parsed);
    return config;
  } catch (e) {
    console.error('[config] Hot-reload failed:', e);
    return null;
  }
}

export function getConfig(): Config {
  if (!config) {
    return loadConfig();
  }
  return config;
}

export function getConfigPath(): string {
  return configPath;
}

// OAuth credential getters (from config or defaults)
export function getGeminiOAuthConfig() {
  const cfg = getConfig();
  return cfg.oauth?.gemini || {
    clientId: DEFAULT_GEMINI_CLIENT_ID,
    clientSecret: DEFAULT_GEMINI_CLIENT_SECRET,
    scopes: DEFAULT_GEMINI_SCOPES,
  };
}

export function getCodexOAuthConfig() {
  const cfg = getConfig();
  return cfg.oauth?.codex || {
    clientId: DEFAULT_CODEX_CLIENT_ID,
    authEndpoint: DEFAULT_CODEX_AUTH_ENDPOINT,
    tokenEndpoint: DEFAULT_CODEX_TOKEN_ENDPOINT,
    apiBase: DEFAULT_CODEX_API_BASE,
  };
}

export function getIFlowOAuthConfig() {
  const cfg = getConfig();
  return cfg.oauth?.iflow || {
    clientId: DEFAULT_IFLOW_CLIENT_ID,
    clientSecret: DEFAULT_IFLOW_CLIENT_SECRET,
    authEndpoint: DEFAULT_IFLOW_AUTH_ENDPOINT,
    tokenEndpoint: DEFAULT_IFLOW_TOKEN_ENDPOINT,
    userinfoEndpoint: DEFAULT_IFLOW_USERINFO_ENDPOINT,
    apiBase: DEFAULT_IFLOW_API_BASE,
  };
}
