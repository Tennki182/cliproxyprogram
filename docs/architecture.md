# ProxyCLI Architecture

## Overview

ProxyCLI is a multi-provider AI reverse proxy that exposes Google Gemini, OpenAI Codex, and iFlow APIs through multiple compatible HTTP interfaces (OpenAI, Gemini, Anthropic formats). It supports multi-account credential rotation, an automatic request queue with exponential backoff retry, and hot-reloadable configuration.

## Project Structure

```
src/
  config.ts                     — YAML config loader with Zod validation + hot-reload
  index.ts                      — Entry point
  server.ts                     — Fastify server bootstrap (TLS, routes, config watcher)
  types/
    openai.ts                   — Strict OpenAI request/response types
    gemini.ts                   — Gemini request types + loose response type (any)
  storage/
    db.ts                       — SQLite (sql.js) initialization and migrations
    credentials.ts              — Credential CRUD + rotation queries (round-robin, fill-first)
    sessions.ts                 — Chat session persistence
  services/
    auth.ts                     — Gemini OAuth flow, token refresh, project discovery
    http.ts                     — Proxy-aware fetch (global + per-credential proxy)
    rotation.ts                 — Multi-account round-robin / fill-first rotation
    queue.ts                    — In-memory request queue with exponential backoff
    models.ts                   — Model alias resolution + wildcard exclusion
    config-watcher.ts           — fs.watch-based config hot-reload
    provider.ts                 — Unified Provider interface
    provider-factory.ts         — Provider factory (routes models to providers)
    backend.ts                  — Gemini Backend interface
    backend-factory.ts          — Gemini backend factory (cloudcode / public)
    gemini.ts                   — CloudCode backend (v1internal API)
    gemini-public.ts            — Public Gemini API backend (v1beta)
    converter.ts                — OpenAI ↔ Gemini format conversion
    providers/
      gemini-provider.ts        — Gemini Provider (wraps Backend + converter)
      codex-provider.ts         — OpenAI Codex Provider (Responses API)
      iflow-provider.ts         — iFlow Provider (OpenAI-compatible + HMAC signing)
  middleware/
    auth.ts                     — Password-based API authentication
  routes/
    auth.ts                     — /auth/* Gemini OAuth login
    auth-codex.ts               — /auth/codex/* Codex OAuth PKCE login
    auth-iflow.ts               — /auth/iflow/* iFlow OAuth login
    openai.ts                   — /v1/chat/completions (OpenAI format)
    models.ts                   — /v1/models (all providers)
    gemini-api.ts               — /v1beta/models/:model:generateContent (Gemini format)
    anthropic.ts                — /v1/messages (Anthropic/Claude format)
    management.ts               — /v0/management/* (accounts, stats, reload)
```

## Data Flow

```
Client ──> Fastify ──> auth middleware ──> Route (OpenAI/Gemini/Anthropic)
                                               │
                                          resolve model alias
                                               │
                                          provider-factory (model → provider)
                                               │
                              ┌────────────────┼────────────────┐
                              │                │                │
                        GeminiProvider    CodexProvider    iFlowProvider
                              │                │                │
                     Backend interface    Responses API   chat/completions
                     (cloudcode/public)   (chatgpt.com)   (apis.iflow.cn)
                              │                │                │
                         enqueue() ────────────────────────────│
                              │                                │
                     acquireCredential() (rotation)            │
                              │                                │
                         Google API / OpenAI / iFlow ──> Response
                              │
                     Convert to output format (OpenAI/Gemini/Anthropic)
```

## Multi-Provider Support

| Provider | Backend | Auth | API Format | Models |
|---|---|---|---|---|
| **Gemini (cloudcode)** | `cloudcode-pa.googleapis.com/v1internal` | OAuth | Envelope `{model, project, request}` | gemini-* |
| **Gemini (public)** | `generativelanguage.googleapis.com/v1beta` | API Key / OAuth | Flat `{contents, ...}` | gemini-* |
| **Codex** | `chatgpt.com/backend-api/codex` | OAuth PKCE | Responses API `{input, instructions}` | gpt-*, o3, o4-*, codex-* |
| **iFlow** | `apis.iflow.cn/v1` | OAuth → API Key + HMAC | OpenAI-compatible | glm-*, qwen*, deepseek-* |

## Multi-Protocol Output

ProxyCLI exposes three API formats simultaneously:

| Endpoint | Format | Description |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | Standard OpenAI Chat Completions API |
| `POST /v1/messages` | Anthropic | Claude Messages API (content blocks, tool_use) |
| `POST /v1beta/models/:model:generateContent` | Gemini | Google Gemini API format |
| `POST /v1beta/models/:model:streamGenerateContent` | Gemini | Gemini streaming |

All formats can access all providers — the proxy handles conversion internally.

## Multi-Account Rotation

### Strategies

| Strategy | Behavior |
|---|---|
| `round-robin` (default) | Picks the least-recently-used credential |
| `fill-first` | Sticks to one credential until it's rate-limited |

### How it works

1. `acquireCredential()` selects based on `routing.strategy` config
2. Filters by provider and rate-limit status
3. Auto-refreshes expired tokens
4. On 429, marks credential as rate-limited via `reportRateLimit()`
5. Max 10 attempts before giving up

## Request Queue

- **Max queue size**: 100
- **Exponential backoff**: `baseIntervalMs * backoffMultiplier ^ (retryNum - 1)`
- **Max retries**: configurable (default 3)
- **Max interval**: configurable (default 30s)
- **Rotation synergy**: retries call `acquireCredential()` again → auto-switches to fresh account

## Model Aliases & Exclusion

```yaml
gemini:
  modelAliases:
    g2.5p: gemini-2.5-pro
    flash: gemini-2.5-flash
  excludedModels:
    - "*-preview"
    - "gemini-1.0-*"
```

Wildcards use `*` for any characters. Aliases are resolved before provider routing.

## Configuration Hot-Reload

The config file is watched with `fs.watch()`. On change:
1. Debounced 500ms
2. Config re-parsed with Zod validation
3. Cached providers reset
4. New requests use updated config

Can also be triggered manually via `POST /v0/management/reload`.

## Management API

All management routes require `Bearer <secret>` auth (uses `management.secret` or falls back to `auth.password`).

| Endpoint | Method | Description |
|---|---|---|
| `/v0/management/accounts` | GET | List all credentials with status |
| `/v0/management/stats` | GET | Usage stats, queue status, uptime |
| `/v0/management/reload` | POST | Force config reload |
| `/v0/management/config` | GET | View current config (redacted) |

## Configuration Reference

```yaml
server:
  host: "0.0.0.0"
  port: 8488

auth:
  password: "your-api-password"

storage:
  type: "sqlite"
  path: "./data/proxycli.db"

gemini:
  defaultModel: "gemini-2.5-flash"
  apiEndpoint: "https://cloudcode-pa.googleapis.com/v1internal"
  backend: "cloudcode"          # "cloudcode" or "public"
  apiKey: ""                    # For public backend
  supportedModels: [...]
  modelAliases: {}              # e.g. { "g2.5p": "gemini-2.5-pro" }
  excludedModels: []            # e.g. ["*-preview"]

codex:
  enabled: false

iflow:
  enabled: false

routing:
  strategy: "round-robin"      # "round-robin" or "fill-first"

retry:
  maxRetries: 3
  backoffMultiplier: 2
  baseIntervalMs: 5000
  maxIntervalMs: 30000

management:
  enabled: true
  secret: ""                   # Empty = use auth.password

tls:
  enabled: false
  cert: ""                     # Path to cert file
  key: ""                      # Path to key file

logging:
  level: "info"

# proxy: "http://127.0.0.1:7890"
```

## Docker

```bash
# Build and run
docker compose up -d

# Or build manually
docker build -t proxycli .
docker run -p 8488:8488 -v ./config.yaml:/app/config.yaml:ro -v ./data:/app/data proxycli
```

## Authentication Flows

### Gemini (OAuth)
1. Visit `/auth/login` → redirects to Google consent screen
2. Callback at `/auth/callback` → exchanges code for tokens
3. Discovers GCP project via Code Assist API

### Codex (OAuth + PKCE)
1. Visit `/auth/codex/login` → redirects to OpenAI Auth0 with PKCE challenge
2. Callback at `/auth/codex/callback` → exchanges code + verifier for tokens
3. Extracts account ID from JWT id_token

### iFlow (OAuth → API Key)
1. Visit `/auth/iflow/login` → redirects to iFlow OAuth
2. Callback at `/auth/iflow/callback` → exchanges code for tokens
3. Fetches API key via user info endpoint
4. Stores API key as credential (used with HMAC signature for API calls)
