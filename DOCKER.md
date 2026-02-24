# Docker 部署指南

## 快速开始

### 使用 Makefile (推荐)

```bash
# 开发环境 (热重载)
make dev

# 生产环境
make up

# 查看日志
make logs

# 停止服务
make down

# 更新镜像
make update
```

### 使用安装脚本

```bash
# 一键安装
curl -fsSL https://raw.githubusercontent.com/Tennki182/cliproxyprogram/main/scripts/install.sh | bash
```

### 手动安装

```bash
# 1. 复制环境变量文件
cp .env.example .env

# 2. 创建数据目录
mkdir -p data certs backups

# 3. 使用 Docker Compose 启动
docker compose up -d
```

## 构建镜像

### 使用 Makefile

```bash
# 构建生产镜像
make build

# 构建并标记版本
make release

# 推送到仓库
make push REGISTRY=ghcr.io/yourusername
```

### 手动构建

```bash
# 标准镜像 (~200MB)
docker build --target production -t proxycli:latest .

# Alpine 镜像 (~100MB, 更小巧)
docker build -f Dockerfile.alpine --target production -t proxycli:alpine .

# 多架构构建
docker buildx build --platform linux/amd64,linux/arm64 -t proxycli:latest .
```

### 使用构建脚本

```bash
# 使用构建脚本 (旧方式，已弃用)
./docker-build.sh build

# 构建特定版本
./docker-build.sh build -t v1.0.0

# Windows PowerShell
.\docker-build.ps1 build
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
./scripts/update.sh
# 或
docker compose pull && docker compose up -d
```

### 开发模式

```bash
# 使用 Makefile
make dev

# 或使用 override 文件
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
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

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXYCLI_PORT` | 8488 | 主机暴露端口 |
| `TZ` | Asia/Shanghai | 时区 |
| `LOG_LEVEL` | info | 日志级别 |
| `PROXYCLI_CPU_LIMIT` | 1 | CPU 限制 |
| `PROXYCLI_MEMORY_LIMIT` | 512M | 内存限制 |

## 数据管理

### 备份

```bash
# 使用 Makefile
make backup

# 使用脚本 (保留最近7天)
./scripts/backup.sh

# 自定义保留天数
./scripts/backup.sh 14

# 查看备份列表
ls -lh backups/
```

### 恢复

```bash
# 停止服务
docker compose down

# 解压备份
tar -xzf backups/proxycli_backup_20240101_120000.tar.gz

# 重启服务
docker compose up -d
```

### 数据持久化

以下目录/文件会被持久化：

- `./data` - SQLite 数据库和会话数据
- `./config.yaml` - 配置文件
- `./certs` - SSL 证书 (如启用 TLS)
- `./backups` - 自动备份目录

## 健康检查

容器内置健康检查，每 30 秒检查一次 `/health` 端点：

```bash
# 查看健康状态
docker compose ps
docker inspect --format='{{.State.Health.Status}}' proxycli

# 使用 Makefile
make stats
```

## 安全特性

- 非 root 用户运行 (UID 1001)
- 只读 root 文件系统
- 无特权模式 (`no-new-privileges`)
- 资源限制 (CPU/内存)
- 自动安全更新 (可选 Watchtower)

## 故障排查

```bash
# 查看日志
docker compose logs -f proxycli
make logs

# 进入容器
docker compose exec proxycli sh
make shell

# 检查配置
docker compose exec proxycli cat /app/config.yaml

# 检查资源使用
make stats

# 重置数据 (警告: 会删除所有数据)
docker compose down -v
rm -rf data/*
docker compose up -d
```

## CI/CD 集成

项目包含 GitHub Actions 工作流：

```bash
# 自动构建并推送到 GHCR
# 触发条件: push 到 main 分支或 tag
```

镜像地址:
- `ghcr.io/tennki182/cliproxyprogram:latest`
- `ghcr.io/tennki182/cliproxyprogram:alpine`

## Makefile 完整命令列表

| 命令 | 说明 |
|------|------|
| `make help` | 显示帮助 |
| `make build` | 构建生产镜像 |
| `make dev` | 启动开发环境 |
| `make up` | 启动生产环境 |
| `make down` | 停止容器 |
| `make logs` | 查看日志 |
| `make shell` | 进入容器 shell |
| `make clean` | 清理容器和镜像 |
| `make release` | 构建并标记版本 |
| `make push` | 推送到仓库 |
| `make test` | 运行测试 |
| `make lint` | 运行类型检查 |
| `make update` | 更新依赖并重建 |
| `make backup` | 备份数据 |
| `make stats` | 查看容器状态 |

## 多架构构建

```bash
# 创建 buildx builder
docker buildx create --use --name proxycli-builder

# 构建多架构镜像
make build
# 或
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag proxycli:latest \
  --push .
```

## 性能优化

### 使用 Alpine 镜像

Alpine 镜像体积比标准镜像小约 50%：

```bash
# 使用 Dockerfile.alpine
docker build -f Dockerfile.alpine -t proxycli:alpine .

# 修改 docker-compose.yml
services:
  proxycli:
    image: proxycli:alpine
```

### 资源限制建议

```yaml
# docker-compose.yml
deploy:
  resources:
    limits:
      cpus: '0.5'
      memory: 256M
    reservations:
      cpus: '0.25'
      memory: 128M
```

## 生产环境建议

1. **使用反向代理**: 配合 Nginx/Caddy 使用 HTTPS
2. **启用自动备份**: 配置备份服务或使用 `make backup`
3. **监控告警**: 集成 Prometheus/Grafana 监控
4. **日志收集**: 配置日志驱动转发到 ELK/Loki
5. **自动更新**: 启用 Watchtower 自动更新镜像

```yaml
# docker-compose.yml 生产配置示例
services:
  proxycli:
    image: ghcr.io/tennki182/cliproxyprogram:latest
    restart: always
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```
