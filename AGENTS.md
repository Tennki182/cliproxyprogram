# proxycli 代理开发指南

## 项目概述

proxycli 是一个多提供者 AI 反向代理，通过统一的 HTTP 接口暴露 Google Gemini、OpenAI Codex、iFlow 等 AI 服务。支持多账户凭证轮换、自动请求队列、指数退避重试和热重载配置。提供 OpenAI、Anthropic 和 Gemini 三种 API 格式兼容。

## 构建与开发命令

| 命令 | 说明 |
|------|------|
| `npm run build` | 编译 TypeScript 到 JavaScript（`tsc`） |
| `npm run dev` | 开发模式热重载运行（`tsx watch src/index.ts`） |
| `npm run start` | 运行编译后的生产构建（`node dist/index.js`） |
| `npm run typecheck` | 类型检查不发射（`tsc --noEmit`） |
| `npm run test` | 通过 Jest 运行测试（`node --experimental-vm-modules node_modules/jest/bin/jest.js`） |

### 运行单个测试

```bash
# 运行指定的测试文件
npm test -- --testPathPattern=filename.test.ts

# 运行指定的测试
npm test -- --testNamePattern="测试名称"

# 监听模式运行
npm test -- --watch
```

## 代码风格指南

### TypeScript 配置

- **目标版本**: ES2022
- **模块系统**: ESNext，使用 bundler 解析
- **严格模式已启用** - 所有严格检查都开启
- **未使用变量检查**: `noUnusedLocals` 和 `noUnusedParameters` 已启用
- 使用显式类型；尽可能避免 `any`

### 导入规则

- 使用 ESM 语法，本地导入需加 `.js` 扩展名：
  ```typescript
  import { foo } from './foo.js';
  import { bar } from '../services/bar.js';
  ```
- 分组导入：外部包优先，然后是本地模块
- 优先使用命名导出而非默认导出

### 命名规范

- **文件**: kebab-case（`auth-middleware.ts`、`provider-factory.ts`）
- **接口**: PascalCase，带 `Provider`/`Backend` 后缀（`GeminiProvider`、`BackendProvider`）
- **函数**: camelCase
- **常量**: SCREAMING_SNAKE_CASE 用于配置值
- **类型**: 简单类型别名用 `type`，复杂对象用 `interface`

### 错误处理

- 异步操作使用 try/catch 块
- 返回适当的 HTTP 状态码（400 表示请求错误，500 表示服务器错误，429 表示限流）
- 使用 `fastify.log.error(error)` 或 `console.error` 记录错误
- 同时处理流式和非流式错误情况
- 精细解析 Gemini 限流响应，提取 retryDelay 和 quotaResetDelay

### 验证规则

- 使用 **Zod** 进行配置模式验证（参见 `src/config.ts`）
- 使用 Fastify 模式进行路由输入验证
- 在 `src/types/` 中为请求/响应对象定义类型/接口

## 代码组织结构

```
src/
├── index.ts                 # 入口点
├── server.ts                # Fastify 服务器设置（TLS、路由、配置监视器）
├── config.ts                # 配置加载 & Zod 模式
├── routes/                  # Fastify 路由处理
│   ├── openai.ts            # /v1/chat/completions (OpenAI 格式)
│   ├── anthropic.ts         # /v1/messages (Anthropic/Claude 格式)
│   ├── gemini-api.ts        # /v1beta/models/:model:generateContent (Gemini 格式)
│   ├── models.ts            # /v1/models (所有提供者模型列表)
│   ├── auth.ts              # /auth/* Gemini OAuth 登录
│   ├── auth-iflow.ts        # /auth/iflow/* iFlow OAuth 登录
│   ├── auth-codex.ts        # /auth/codex/* Codex OAuth PKCE 登录
│   ├── auth-remote.ts       # 远程认证端点
│   ├── management.ts        # /v0/management/* (账户、统计、重载)
│   └── openai-compat-management.ts  # OpenAI 兼容提供者管理
├── services/                # 业务逻辑，提供者
│   ├── provider.ts          # 统一 Provider 接口
│   ├── provider-factory.ts  # Provider 工厂（模型路由到提供者）
│   ├── backend.ts           # Gemini Backend 接口
│   ├── backend-factory.ts   # Backend 工厂（cloudcode / public）
│   ├── gemini.ts            # CloudCode Backend (v1internal API)
│   ├── gemini-public.ts     # 公共 Gemini API Backend (v1beta)
│   ├── converter.ts         # OpenAI ↔ Gemini 格式转换
│   ├── payload.ts           # 负载处理
│   ├── auth.ts              # Gemini OAuth 流程、Token 刷新、项目发现
│   ├── http.ts              # 代理感知的 fetch（全局 + 每凭证代理）
│   ├── rotation.ts          # 多账户轮询 / fill-first 轮换
│   ├── queue.ts             # 内存请求队列（指数退避）
│   ├── config-watcher.ts    # 基于 fs.watch 的配置热重载
│   ├── token-counter.ts     # 本地 Token 计数和估算
│   ├── token-refresher.ts   # Token 刷新
│   ├── sse-utils.ts         # SSE 工具
│   ├── log-stream.ts        # 日志流
│   ├── models.ts            # 模型别名解析 + 通配符排除
│   ├── usage.ts             # 使用统计
│   ├── pinyin.ts            # 拼音处理
│   └── providers/           # 具体提供者实现
│       ├── gemini-provider.ts      # Gemini Provider
│       ├── codex-provider.ts       # Codex Provider（Responses API）
│       ├── iflow-provider.ts       # iFlow Provider（OpenAI 兼容 + HMAC 签名）
│       └── openai-compat-provider.ts  # OpenAI 兼容提供者
├── middleware/              # Fastify 中间件
│   └── auth.ts              # 基于密码的 API 认证
├── storage/                 # 数据库（通过 sql.js 的 SQLite）
│   ├── db.ts                # 数据库初始化和迁移
│   ├── credentials.ts       # 凭证 CRUD + 轮换查询
│   ├── sessions.ts          # 聊天会话持久化
│   ├── openai-compat.ts     # OpenAI 兼容提供者存储
│   └── utils.ts             # 存储工具
└── types/                   # TypeScript 接口定义
    ├── openai.ts            # OpenAI 请求/响应类型
    └── gemini.ts            # Gemini 请求类型
```

## 架构概览

### 多提供者支持

| 提供者 | 后端 | 认证 | API 格式 | 模型 |
|---|---|---|---|---|
| **Gemini (cloudcode)** | `cloudcode-pa.googleapis.com/v1internal` | OAuth | 信封 `{model, project, request}` | gemini-* |
| **Gemini (public)** | `generativelanguage.googleapis.com/v1beta` | API Key / OAuth | 扁平 `{contents, ...}` | gemini-* |
| **Codex** | `chatgpt.com/backend-api/codex` | OAuth PKCE | Responses API | gpt-*, o3, o4-*, codex-* |
| **iFlow** | `apis.iflow.cn/v1` | OAuth → API Key + HMAC | OpenAI 兼容 | glm-*, qwen*, deepseek-* |
| **OpenAI 兼容** | 动态配置 | API Key | OpenAI 兼容 | 自定义 |

### 数据流

```
客户端 ──> Fastify ──> 认证中间件 ──> 路由 (OpenAI/Gemini/Anthropic)
                                            │
                                       解析模型别名
                                            │
                                   provider-factory (模型 → 提供者)
                                            │
                      ┌─────────────────────┼─────────────────────┐
                      │                     │                     │
                GeminiProvider      CodexProvider         iFlowProvider
                      │                     │                     │
               Backend 接口          Responses API      chat/completions
               (cloudcode/public)      (chatgpt.com)    (apis.iflow.cn)
                      │                     │                     │
                 enqueue() ────────────────────────────────────────│
                      │                                           │
               acquireCredential() (轮换)                         │
                      │                                           │
            Google API / OpenAI / iFlow ──> 响应                  │
                      │                                           │
            转换为输出格式 (OpenAI/Gemini/Anthropic) <────────────┘
```

### 多协议输出

proxycli 同时暴露三种 API 格式：

| 端点 | 格式 | 说明 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | 标准 OpenAI 对话补全 API |
| `POST /v1/messages` | Anthropic | Claude Messages API（内容块、tool_use） |
| `POST /v1beta/models/:model:generateContent` | Gemini | Google Gemini API 格式 |
| `POST /v1beta/models/:model:streamGenerateContent` | Gemini | Gemini 流式格式 |

所有格式都可以访问所有提供者 —— 代理在内部处理转换。

## 核心功能

### 多账户轮换

| 策略 | 行为 |
|---|---|
| `round-robin` (默认) | 选择最近最少使用的凭证 |
| `fill-first` | 坚持使用一个凭证直到被限流 |

工作流程：
1. `acquireCredential()` 根据 `routing.strategy` 配置选择
2. 按提供者和限流状态过滤
3. 自动刷新过期 Token
4. 遇到 429 时通过 `reportRateLimit()` 标记凭证限流
5. 最多 10 次尝试后放弃

### 请求队列

- **最大队列大小**: 100
- **指数退避**: `baseIntervalMs * backoffMultiplier ^ (retryNum - 1)`
- **最大重试次数**: 可配置（默认 3）
- **最大间隔**: 可配置（默认 30s）
- **轮换协同**: 重试调用 `acquireCredential()` 再次 → 自动切换到新账户

### 模型别名与排除

```yaml
gemini:
  modelAliases:
    g2.5p: gemini-2.5-pro
    flash: gemini-2.5-flash
  excludedModels:
    - "*-preview"
    - "gemini-1.0-*"
```

通配符使用 `*` 匹配任意字符。别名在提供者路由前解析。

### 配置热重载

配置文件使用 `fs.watch()` 监视。变更时：
1. 防抖 500ms
2. 使用 Zod 验证重新解析配置
3. 重置缓存的提供者
4. 新请求使用更新后的配置

也可通过 `POST /v0/management/reload` 手动触发。

## 代码模式

- 路由文件导出一个在 Fastify 实例上注册路由的函数：
  ```typescript
  export async function openaiRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.post('/v1/chat/completions', { schema: {...} }, handler);
  }
  ```
- 提供者接口（`src/services/provider.ts`）抽象后端实现
- 使用异步生成器处理流式响应
- 流式端点使用 SSE keep-alive（15 秒间隔）
- Token 计数在 `token-counter.ts` 中实现，支持中英文不同估算策略

## 高级功能

### Token 计数与估算

- **文件**: `src/services/token-counter.ts`
- 本地 Token 估算，针对中英文使用不同策略：
  - 中文: ~1.5 字符/Token
  - 英文/代码: ~4 字符/Token
- 在 iFlow 和 Codex Provider 中集成
- 当 API 未返回 usage 时使用估算值填充，标记为 `usage.estimated: true`

### 缓存机制 (prompt_cache_key)

- **文件**: `src/services/providers/codex-provider.ts`
- 支持从请求中提取缓存键：
  - `metadata.user_id` (Claude 风格)
  - `prompt_cache_key` (直接指定)
- 缓存有效期: 1 小时
- 自动添加 `Conversation_id` 和 `Session_id` 请求头

### 内置工具透传

- **文件**: `src/services/converter.ts`
- 支持的工具类型（snake_case 和 camelCase）：
  - `google_search` / `googleSearch`
  - `code_execution` / `codeExecution`
  - `url_context` / `urlContext`

### 限流精细解析

- **文件**: `src/services/gemini.ts`
- 支持多种限流格式：
  - `RetryInfo.retryDelay` (如 "60s" 或 { seconds: 60 })
  - `ErrorInfo.metadata.quotaResetDelay` (如 "373.801628ms")
  - 错误消息模式: "Your quota will reset after Xs."

### iFlow Cookie 刷新

- **文件**: `src/services/providers/iflow-provider.ts`
- 自动刷新凭证，支持两种方式：
  - Cookie 刷新: 使用 `refreshCookieBasedAPIKey()`
  - OAuth 刷新: 使用 `refreshOAuthTokens()`
- 凭证过期前 5 分钟自动触发

### reasoning_content 多轮保留

- **文件**: `src/services/providers/iflow-provider.ts`
- 保留 assistant 消息中的 `reasoning_content` 字段
- 支持 GLM-4.6/4.7 和 MiniMax M2/M1 等模型的多轮推理

## 管理 API

所有管理路由需要 `Bearer <secret>` 认证（使用 `management.secret` 或回退到 `auth.password`）。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v0/management/accounts` | GET | 列出所有凭证及状态 |
| `/v0/management/stats` | GET | 使用统计、队列状态、运行时间 |
| `/v0/management/reload` | POST | 强制重载配置 |
| `/v0/management/config` | GET | 查看当前配置（脱敏） |
| `/v0/management/openai-compat/providers` | GET/POST/DELETE | OpenAI 兼容提供者管理 |

## 测试

- 测试放在 `tests/` 目录（目前尚未实现）
- 使用支持 ESM 的 Jest
- 添加测试时遵循现有代码模式

## 最佳实践

- 始终处理关闭信号（SIGINT、SIGTERM）
- 使用环境变量或 `config.yaml` 进行配置
- 需要时通过配置启用 TLS
- 在适当级别记录重要事件
- 使用 `zod` 进行运行时配置验证
- 空工具数组处理：当 tools 为空数组时，添加 placeholder 工具避免 provider 异常

## 依赖库

### 核心依赖
- **fastify**: ^5.1.0 - Web 框架
- **@fastify/cors**: ^10.0.1 - CORS 支持
- **@fastify/formbody**: ^8.0.1 - 表单 body 解析
- **@fastify/static**: ^9.0.0 - 静态文件服务
- **@fastify/websocket**: ^11.2.0 - WebSocket 支持

### 数据与验证
- **zod**: ^3.24.1 - 模式验证
- **sql.js**: ^1.11.0 - 内存 SQLite 数据库
- **yaml**: ^2.7.0 - 配置文件解析

### 开发依赖
- **typescript**: ^5.7.3 - TypeScript 编译器
- **tsx**: ^4.19.2 - 开发用 TypeScript 执行器
- **@types/node**: ^20.0.0 - Node.js 类型定义
- **@types/sql.js**: ^1.4.9 - sql.js 类型定义
- **@types/ws**: ^8.18.1 - WebSocket 类型定义

### 可选依赖
- **playwright-core**: ^1.50.0 - 浏览器自动化（可选）

## 关键文件

- `src/config.ts`: 配置模式定义和加载（支持热重载）
- `src/server.ts`: 服务器初始化和路由注册
- `src/routes/openai.ts`: OpenAI 兼容端点
- `src/routes/anthropic.ts`: Anthropic/Claude 兼容端点
- `src/services/provider-factory.ts`: 提供者路由逻辑
- `src/services/token-counter.ts`: Token 计数和估算
- `src/types/`: TypeScript 类型定义
- `docs/architecture.md`: 详细架构文档

## Docker 支持

```bash
# 构建并运行
docker compose up -d

# 或手动构建
docker build -t proxycli .
docker run -p 8488:8488 -v ./config.yaml:/app/config.yaml:ro -v ./data:/app/data proxycli
```

## OAuth 配置重要说明

**【切勿在 config.yaml 中配置 codex 和 iflow 的 OAuth 凭证！**]

代码中内置了 codex 和 iflow 的默认 OAuth 凭证：
- **Codex**: `clientId: app_EMoamEEZ73f0CkXaXp7hrann`
- **iFlow**: `clientId: 10009311001`, `clientSecret: 4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW`

配置逻辑是 `cfg.oauth?.codex || defaultConfig`，如果配置了无效的占位符（如 `your-xxx-client-id`），会导致 OAuth 授权失败。

**正确做法**：config.yaml 中只配置 `oauth.gemini`，不要添加 `oauth.codex` 或 `oauth.iflow` 节点。

## 认证流程

### Gemini (OAuth)
1. 访问 `/auth/login` → 重定向到 Google 授权页面
2. 回调到 `/auth/callback` → 交换 code 获取 tokens
3. 通过 Code Assist API 发现 GCP 项目

### Codex (OAuth + PKCE)
1. 访问 `/auth/codex/login` → 重定向到 OpenAI Auth0（带 PKCE challenge）
2. 回调到 `/auth/codex/callback` → 交换 code + verifier 获取 tokens
3. 从 JWT id_token 提取账户 ID

### iFlow (OAuth → API Key)
1. 访问 `/auth/iflow/login` → 重定向到 iFlow OAuth
2. 回调到 `/auth/iflow/callback` → 交换 code 获取 tokens
3. 通过 user info 端点获取 API key
4. 存储 API key 作为凭证（API 调用时使用 HMAC 签名）

## 环境要求

- **Node.js**: >= 20.0.0
- **TypeScript**: 5.7.3+
- **平台**: Windows、macOS、Linux 均支持