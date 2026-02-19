# ProxyCLI 项目变更日志

## 2026-02-20

### 新增文件

| 文件路径 | 说明 |
|----------|------|
| `package.json` | Node.js项目配置 |
| `tsconfig.json` | TypeScript配置 |
| `config.yaml` | 应用配置文件 |
| `Dockerfile` | Docker镜像配置 |
| `docker-compose.yml` | Docker编排配置 |
| `public/index.html` | 管理前端页面 |

### 源代码文件

| 文件路径 | 说明 |
|----------|------|
| `src/index.ts` | 入口文件 |
| `src/config.ts` | 配置加载模块 |
| `src/server.ts` | Fastify服务器 |
| `src/middleware/auth.ts` | 认证中间件 |
| `src/routes/openai.ts` | OpenAI兼容接口 |
| `src/routes/models.ts` | 模型列表接口 |
| `src/routes/auth.ts` | 认证接口 |
| `src/services/auth.ts` | OAuth认证服务 |
| `src/services/gemini.ts` | Gemini API调用 |
| `src/services/converter.ts` | 格式转换 |
| `src/services/cli-auth.ts` | CLI认证(占位) |
| `src/storage/db.ts` | SQLite数据库 |
| `src/storage/credentials.ts` | 凭证存储 |
| `src/storage/sessions.ts` | 会话管理 |
| `src/types/openai.ts` | OpenAI类型定义 |
| `src/types/gemini.ts` | Gemini类型定义 |

### 主要功能

1. **端口**: 8488
2. **认证**: 支持API Key和OAuth设备码流程
3. **端点**:
   - `/v1/chat/completions` - OpenAI兼容聊天接口
   - `/v1/models` - 模型列表
   - `/auth/device` - 设备授权
   - `/auth/poll` - 轮询token
   - `/auth/status` - 认证状态
4. **前端**: 现代化深色主题管理面板

### 配置说明

编辑 `config.yaml`:
```yaml
# 使用API Key方式
apiKey: "YOUR_API_KEY"

# 或使用OAuth方式（需配置Google Cloud项目）
oauth:
  clientId: "YOUR_CLIENT_ID"
  clientSecret: "YOUR_CLIENT_SECRET"
```

### 启动命令

```bash
npm run dev    # 开发模式
# 或
docker-compose up -d  # Docker部署
```
