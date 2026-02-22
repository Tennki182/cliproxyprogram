# Docker 部署指南

## 快速开始

```bash
# 1. 复制环境变量文件
cp .env.example .env

# 2. 创建数据目录
mkdir -p data certs

# 3. 使用 Docker Compose 启动
docker compose up -d
```

## 构建镜像

```bash
# 使用构建脚本 (推荐)
./docker-build.sh build

# 构建特定版本
./docker-build.sh build -t v1.0.0

# 构建开发版本
./docker-build.sh build --target development

# 无缓存构建
./docker-build.sh build --no-cache

# Windows PowerShell
.\docker-build.ps1 build
.\docker-build.ps1 build -Tag v1.0.0
```

## 运行

### Docker Compose (推荐)

```bash
# 启动服务
docker compose up -d

# 查看日志
docker compose logs -f

# 停止服务
docker compose down

# 重启服务
docker compose restart

# 更新到最新版本
docker compose pull && docker compose up -d
```

### 纯 Docker

```bash
# 运行容器
docker run -d \
  --name proxycli \
  -p 8488:8488 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config.yaml:/app/config.yaml:ro \
  --restart unless-stopped \
  proxycli:latest
```

## 开发模式

```bash
# 使用 override 文件启动开发环境
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d

# 或者直接
docker compose up -d --build
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXYCLI_PORT` | 8488 | 主机暴露端口 |
| `TZ` | Asia/Shanghai | 时区 |
| `LOG_LEVEL` | info | 日志级别 |
| `PROXYCLI_CPU_LIMIT` | 1 | CPU 限制 |
| `PROXYCLI_MEMORY_LIMIT` | 512M | 内存限制 |

## 数据持久化

以下目录/文件会被持久化：

- `./data` - SQLite 数据库和会话数据
- `./config.yaml` - 配置文件
- `./certs` - SSL 证书 (如启用 TLS)

## 健康检查

容器内置健康检查，每 30 秒检查一次 `/health` 端点：

```bash
# 查看健康状态
docker compose ps
docker inspect --format='{{.State.Health.Status}}' proxycli
```

## 安全特性

- 非 root 用户运行 (UID 1001)
- 只读 root 文件系统
- 无特权模式 (`no-new-privileges`)
- 资源限制 (CPU/内存)

## 故障排查

```bash
# 查看日志
docker compose logs -f proxycli

# 进入容器
docker compose exec proxycli sh

# 检查配置
docker compose exec proxycli cat /app/config.yaml

# 重置数据 (警告: 会删除所有数据)
docker compose down -v
rm -rf data/*
docker compose up -d
```

## 多架构构建

```bash
# 创建 buildx builder
docker buildx create --use --name proxycli-builder

# 构建多架构镜像
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag proxycli:latest \
  --push .
```
