# proxycli 代理开发指南

## 项目概述

proxycli 是一个 Gemini CLI 反向代理，通过 Code Assist 提供 OpenAI 兼容 API。是一个使用 Fastify 作为 Web 服务器的 TypeScript/Node.js 项目。

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
- **接口**: PascalCase，带 `Provider` 后缀（`GeminiProvider`、`BackendProvider`）
- **函数**: camelCase
- **常量**: SCREAMING_SNAKE_CASE 用于配置值
- **类型**: 简单类型别名用 `type`，复杂对象用 `interface`

### 错误处理

- 异步操作使用 try/catch 块
- 返回适当的 HTTP 状态码（400 表示请求错误，500 表示服务器错误）
- 使用 `fastify.log.error(error)` 或 `console.error` 记录错误
- 同时处理流式和非流式错误情况

### 验证规则

- 使用 **Zod** 进行配置模式验证（参见 `src/config.ts`）
- 使用 Fastify 模式进行路由输入验证
- 在 `src/types/` 中为请求/响应对象定义类型/接口

### 代码组织结构

```
src/
├── index.ts                 # 入口点
├── server.ts                # Fastify 服务器设置
├── config.ts                # 配置加载 & Zod 模式
├── routes/                  # Fastify 路由处理
│   ├── openai.ts            # OpenAI 兼容端点
│   ├── management.ts        # 管理端点
│   ├── models.ts            # 模型列表端点
│   ├── auth.ts              # 认证端点
│   ├── auth-iflow.ts        # iFlow 认证
│   ├── auth-codex.ts        # Codex 认证
│   ├── gemini-api.ts        # Gemini API 端点
│   └── anthropic.ts         # Anthropic 端点
├── services/                # 业务逻辑，提供者
│   ├── provider.ts          # 提供者接口
│   ├── provider-factory.ts  # 提供者工厂
│   ├── backend.ts           # 后端抽象
│   ├── backend-factory.ts   # 后端工厂
│   ├── rotation.ts          # 提供者轮换
│   ├── queue.ts             # 请求队列
│   ├── token-refresher.ts   # Token 刷新
│   ├── converter.ts         # 请求/响应转换
│   ├── payload.ts           # 负载处理
│   ├── auth.ts              # 认证服务
│   ├── http.ts              # HTTP 客户端
│   ├── sse-utils.ts         # SSE 工具
│   ├── log-stream.ts        # 日志流
│   ├── gemini.ts            # Gemini 服务
│   ├── gemini-public.ts     # 公共 Gemini
│   ├── models.ts            # 模型管理
│   └── providers/           # 具体提供者实现
│       ├── gemini-provider.ts
│       ├── iflow-provider.ts
│       └── codex-provider.ts
├── middleware/              # Fastify 中间件
│   └── auth.ts              # 认证中间件
├── storage/                 # 数据库（通过 sql.js 的 SQLite）
│   ├── db.ts                # 数据库初始化
│   ├── sessions.ts          # 会话管理
│   ├── credentials.ts       # 凭证存储
│   └── utils.ts             # 存储工具
└── types/                   # TypeScript 接口定义
    ├── openai.ts            # OpenAI 类型
    └── gemini.ts            # Gemini 类型
```

### 代码模式

- 路由文件导出一个在 Fastify 实例上注册路由的函数：
  ```typescript
  export async function openaiRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.post('/v1/chat/completions', { schema: {...} }, handler);
  }
  ```
- 提供者接口（`src/services/provider.ts`）抽象后端实现
- 使用异步生成器处理流式响应
- 流式端点使用 SSE keep-alive（15 秒间隔）

### 测试

- 测试放在 `tests/` 目录（目前尚未实现）
- 使用支持 ESM 的 Jest
- 添加测试时遵循现有代码模式

### 最佳实践

- 始终处理关闭信号（SIGINT、SIGTERM）
- 使用环境变量或 `config.yaml` 进行配置
- 需要时通过配置启用 TLS
- 在适当级别记录重要事件
- 使用 `zod` 进行运行时配置验证

## 依赖库

- **fastify**: Web 框架
- **@fastify/cors**: CORS 支持
- **@fastify/formbody**: 表单 body 解析
- **@fastify/static**: 静态文件服务
- **@fastify/websocket**: WebSocket 支持
- **zod**: 模式验证
- **sql.js**: 内存 SQLite 数据库
- **yaml**: 配置文件解析
- **tsx**: 开发用 TypeScript 执行器

## 关键文件

- `src/config.ts`: 配置模式定义和加载
- `src/server.ts`: 服务器初始化和路由注册
- `src/routes/openai.ts`: OpenAI 兼容端点
- `src/services/provider-factory.ts`: 提供者路由逻辑
- `src/types/`: TypeScript 类型定义
