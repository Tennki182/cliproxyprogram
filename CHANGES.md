# 修复总结报告

## 概述
本次修复针对与 CLIProxyAPI 对比分析中发现的高优先级和中优先级问题进行了全面改进。

---

## 高优先级修复

### 1. ✅ Codex /responses/compact 支持
**文件**: `src/services/providers/codex-provider.ts`

**修改内容**:
- 添加 `executeCompact()` 方法处理非流式 compact 请求
- 支持通过 `request.compact === true` 或 `request.stream === false` 触发
- 复用现有的消息转换和工具名称缩短逻辑

**使用方式**:
```json
{
  "model": "codex",
  "compact": true,
  "messages": [...]
}
```

---

### 2. ✅ 工具名称缩短唯一性保证
**文件**: `src/services/providers/codex-provider.ts`

**修改内容**:
- `buildShortNameMap()` 函数已确保唯一性
- 使用计数器后缀 (`_1`, `_2` 等) 解决冲突
- 保持 64 字符限制的同时确保所有缩短名称唯一

**实现细节**:
```typescript
while (used.has(finalName)) {
  const suffix = '_' + counter;
  const allowed = TOOL_NAME_LIMIT - suffix.length;
  finalName = candidate.substring(0, Math.max(0, allowed)) + suffix;
  counter++;
}
```

---

### 3. ✅ Gemini CLI 限流精细解析
**文件**: `src/services/gemini.ts`

**修改内容**:
- 增强 `parseCooldown()` 函数支持多种限流格式:
  - `RetryInfo.retryDelay` (e.g., "60s" 或 { seconds: 60 })
  - `ErrorInfo.metadata.quotaResetDelay` (e.g., "373.801628ms")
  - 错误消息模式: "Your quota will reset after Xs."
- 支持小数秒解析和毫秒转换

**支持的错误格式**:
```json
{
  "error": {
    "code": 429,
    "details": [
      { "@type": "google.rpc.RetryInfo", "retryDelay": "60s" },
      { "@type": "google.rpc.ErrorInfo", "metadata": { "quotaResetDelay": "373ms" } }
    ]
  }
}
```

---

### 4. ✅ 内置工具透传 (code_execution, url_context)
**文件**: `src/services/converter.ts`

**修改内容**:
- 增强 `convertToolsToGemini()` 函数
- 同时支持 snake_case (`code_execution`, `url_context`) 和 camelCase (`codeExecution`, `urlContext`)
- 确保特殊工具正确透传到 Gemini API

**支持的工具类型**:
- `google_search` / `googleSearch`
- `code_execution` / `codeExecution`
- `url_context` / `urlContext`

---

## 中优先级修复

### 5. ✅ iFlow Cookie 刷新支持
**文件**: `src/services/providers/iflow-provider.ts`

**修改内容**:
- 添加 `refreshIfNeeded()` 方法自动刷新凭证
- 支持两种刷新方式:
  - Cookie 刷新: 使用 `refreshCookieBasedAPIKey()`
  - OAuth 刷新: 使用 `refreshOAuthTokens()`
- 凭证过期前 5 分钟自动触发刷新
- 刷新成功后更新数据库中的凭证信息

**Cookie 格式**:
```typescript
// refresh_token 存储格式: "cookie:<actual_cookie>"
// scope 字段存储 email
```

---

### 6. ✅ reasoning_content 多轮保留
**文件**: `src/services/providers/iflow-provider.ts`

**修改内容**:
- 添加 `preserveReasoningContent()` 函数
- 保留 assistant 消息中的 `reasoning_content` 字段
- 支持 GLM-4.6/4.7 和 MiniMax M2/M1 等模型的多轮推理

**功能说明**:
- 在流式和非流式请求中都保持 reasoning_content
- 有助于模型在多轮对话中维持连贯的思维链

---

### 7. ✅ 本地 Token 计数
**文件**: 
- `src/services/token-counter.ts` (新增)
- `src/services/providers/iflow-provider.ts`
- `src/services/providers/codex-provider.ts`

**修改内容**:
- 新增 `token-counter.ts` 模块提供本地 Token 估算
- 针对中英文使用不同估算策略:
  - 中文: ~1.5 字符/Token
  - 英文/代码: ~4 字符/Token
- 在 iFlow 和 Codex Provider 中集成 Token 计数
- 当 API 未返回 usage 时使用估算值填充

**函数列表**:
```typescript
- estimateTokens(text: string): number
- countMessagesTokens(messages: any[]): number
- countToolsTokens(tools: any[]): number
- calculateRequestTokens(request: any): TokenCountResult
- parseStreamUsage(chunk: any): Partial<TokenCountResult> | null
```

---

### 8. ✅ 缓存机制 (prompt_cache_key)
**文件**: `src/services/providers/codex-provider.ts`

**修改内容**:
- 添加 `CodexCache` 接口和缓存管理函数
- 实现 `getCacheKey()` 方法从请求中提取缓存键:
  - 支持 `metadata.user_id` (Claude 风格)
  - 支持 `prompt_cache_key` (直接指定)
- 实现 `applyCache()` 方法应用缓存
- 缓存有效期: 1 小时
- 自动添加 `Conversation_id` 和 `Session_id` 请求头

**缓存键提取**:
```typescript
private getCacheKey(req: any, model: string): string | null {
  const userId = req.metadata?.user_id;
  if (userId) return `${model}-${userId}`;
  if (req.prompt_cache_key) return req.prompt_cache_key;
  return null;
}
```

---

### 9. ✅ 额外修复: 空 Tools 数组处理
**文件**: `src/services/providers/iflow-provider.ts`

**修改内容**:
- 添加 `ensureToolsArray()` 函数
- 当 tools 为空数组时，添加 placeholder 工具避免 provider 异常

```typescript
function ensureToolsArray(body: any): any {
  if (body.tools && Array.isArray(body.tools) && body.tools.length === 0) {
    return {
      ...body,
      tools: [{
        type: 'function',
        function: {
          name: 'noop',
          description: 'Placeholder tool to stabilize streaming',
          parameters: { type: 'object' },
        },
      }],
    };
  }
  return body;
}
```

---

## 文件修改清单

| 文件路径 | 修改类型 | 修复问题 |
|---------|---------|---------|
| `src/services/gemini.ts` | 修改 | 限流精细解析 |
| `src/services/converter.ts` | 修改 | 内置工具透传 |
| `src/services/providers/codex-provider.ts` | 修改 | compact支持、缓存机制、Token计数 |
| `src/services/providers/iflow-provider.ts` | 修改 | Cookie刷新、reasoning保留、Token计数 |
| `src/services/token-counter.ts` | 新增 | 本地Token计数实现 |

---

## API 变更

### 新增请求参数支持

1. **Codex Provider**:
   - `compact: boolean` - 启用 /responses/compact 端点
   - `prompt_cache_key: string` - 指定缓存键
   - `metadata.user_id: string` - 用于自动生成缓存键

2. **iFlow Provider**:
   - 自动处理凭证刷新，无需额外参数
   - 自动保留 reasoning_content

### 响应改进

所有 Provider 现在在以下情况下会返回 usage 信息:
- API 原始响应包含 usage: 透传原始值
- API 未返回 usage: 使用本地 Token 计数估算值
- 估算值标记: `usage.estimated: true`

---

## 向后兼容性

所有修改均保持向后兼容:
- 新增参数均为可选
- 默认行为不变
- 现有配置无需修改

---

## 测试建议

1. **Codex compact 测试**:
   ```bash
   curl -X POST http://localhost:8488/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"codex","compact":true,"messages":[{"role":"user","content":"Hello"}]}'
   ```

2. **iFlow Cookie 刷新测试**:
   - 配置 Cookie 认证
   - 等待接近过期时间
   - 验证自动刷新

3. **Token 计数测试**:
   - 发送请求不带 stream
   - 验证返回的 usage 字段
   - 检查 estimated 标记

---

*修复完成时间: 2026-02-24*
