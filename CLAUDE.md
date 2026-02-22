# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

### Local Development
```bash
npm run build          # tsc — compile TypeScript to dist/
npm run dev            # tsx watch src/index.ts — hot-reload dev server
npm start              # node dist/index.js — run compiled output
npx tsc --noEmit       # type-check without emitting
npm test               # jest (no test files exist yet)
```

### Docker
```bash
# Quick start
docker compose up -d

# Build
./docker-build.sh build              # Production build
./docker-build.sh build --target development  # Dev build
./docker-build.sh build -t v1.0.0   # Tagged build

# Compose operations
./docker-build.sh compose-up         # Start services
./docker-build.sh compose-down       # Stop services
./docker-build.sh clean              # Cleanup

# Windows PowerShell
.\docker-build.ps1 build
.\docker-build.ps1 compose-up
```

See [DOCKER.md](DOCKER.md) for detailed Docker deployment guide.

## Architecture Overview

Multi-provider AI reverse proxy that accepts requests in OpenAI, Anthropic, and Gemini formats, routes them through pluggable providers (Gemini, Codex, iFlow), and returns responses in the requested format.

### Request Flow

```
Client request (OpenAI/Anthropic/Gemini format)
  → Route handler converts to OpenAI-format internal request
    → getProviderForRequest(model)  [provider-factory.ts]
      → resolveModelAlias(model)    [models.ts]
      → getProviderForModel(model)  [models.ts: Codex → iFlow → Gemini priority]
    → enqueue()                     [queue.ts: retry with exponential backoff on 429]
      → provider.chatCompletion()   [provider calls upstream API]
  → Route handler converts OpenAI-format response back to client's format
```

All providers implement the `Provider` interface (`src/services/provider.ts`) and accept/return OpenAI-format internally. Format conversion between protocols happens in the route layer.

### Key Abstractions

- **Provider** (`src/services/provider.ts`) — unified interface: `chatCompletion()`, `chatCompletionStream()`, `isModelSupported()`
- **Backend** (`src/services/backend.ts`) — Gemini-specific abstraction over cloudcode vs public API. Wrapped by `GeminiProvider`
- **Rotation** (`src/services/rotation.ts`) — credential selection via `acquireCredential()`. Strategies: round-robin (LRU) or fill-first (sticky)
- **Queue** (`src/services/queue.ts`) — single-concurrency request queue with 429 detection and exponential backoff. All outbound calls go through `enqueue()`

### Route → Protocol Mapping

| Route | Format | File |
|-------|--------|------|
| `POST /v1/chat/completions` | OpenAI | `src/routes/openai.ts` |
| `POST /v1/messages` | Anthropic | `src/routes/anthropic.ts` |
| `POST /v1beta/models/*` | Gemini | `src/routes/gemini-api.ts` |
| `GET /v1/models` | OpenAI | `src/routes/models.ts` |
| `/v0/management/*` | Custom | `src/routes/management.ts` |
| `/v0/management/openai-compat/*` | Provider CRUD | `src/routes/openai-compat-management.ts` |
| `/auth/*` | OAuth flows | `src/routes/auth.ts`, `auth-codex.ts`, `auth-iflow.ts` |

### Provider Implementations

- **GeminiProvider** (`src/services/providers/gemini-provider.ts`) — delegates to Backend (cloudcode or public). Converter in `src/services/converter.ts` handles OpenAI↔Gemini message/tool format translation
- **CodexProvider** (`src/services/providers/codex-provider.ts`) — OAuth PKCE auth, calls Responses API at `chatgpt.com/backend-api/codex/responses`
- **IFlowProvider** (`src/services/providers/iflow-provider.ts`) — HMAC-SHA256 signed requests to `apis.iflow.cn/v1/chat/completions`
- **OpenAICompatProvider** (`src/services/providers/openai-compat-provider.ts`) — generic OpenAI-compatible provider for third-party APIs (OpenRouter, SiliconFlow, etc.). Supports dynamic configuration via database

### Config & Hot-Reload

Config is a Zod-validated `config.yaml` (`src/config.ts`). `fs.watch()` with 500ms debounce triggers `reloadConfig()` → `resetProviders()` + `resetBackend()` to clear all cached singletons.

### Database

SQLite via sql.js (in-memory, persisted to disk on every write). Migrations are inline `ALTER TABLE ADD COLUMN` wrapped in try/catch. Tables:
- `credentials` — provider accounts with rotation metadata
- `sessions` — chat history
- `openai_compat_providers` — dynamic OpenAI-compatible provider configurations
- `openai_compat_models` — models for dynamic providers

## Conventions

- **ESM throughout** — all imports use `.js` extension (`import { x } from './y.js'`)
- **Singleton caching** — config, providers, backend, HTTP dispatchers are lazy-initialized module-level variables, cleared on hot-reload
- **Language** — error messages and log strings use Chinese (中文)
- **Auth middleware** skips: `/health`, `/v1/models`, `/auth/*`, `/admin`, `/v0/management` (has own auth)
- **SSE keep-alive** — streaming routes send heartbeat comments every 15s to prevent proxy timeouts
- **`expires_at`** is stored in milliseconds; **`rate_limited_until`** is in Unix seconds
- **tsconfig** — `strict: true`, `noUnusedLocals`, `noUnusedParameters`, target ES2022
