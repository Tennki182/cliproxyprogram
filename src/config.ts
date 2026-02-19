import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';

const ConfigSchema = z.object({
  server: z.object({
    host: z.string(),
    port: z.number(),
  }),
  auth: z.object({
    password: z.string(),
  }),
  storage: z.object({
    type: z.string(),
    path: z.string(),
  }),
  gemini: z.object({
    defaultModel: z.string(),
    supportedModels: z.array(z.string()),
  }),
  oauth: z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    redirectUri: z.string(),
    scopes: z.array(z.string()),
  }),
  apiKey: z.string().optional(),
  logging: z.object({
    level: z.string(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

let config: Config | null = null;

export function loadConfig(path: string = './config.yaml'): Config {
  if (config) return config;

  const fileContent = readFileSync(path, 'utf-8');
  const parsed = parse(fileContent);

  config = ConfigSchema.parse(parsed);
  return config;
}

export function getConfig(): Config {
  if (!config) {
    return loadConfig();
  }
  return config;
}
