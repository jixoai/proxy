# Proxy 项目

这是一个基于 Bun 的代理服务器和查看器项目。

## 功能

- **代理服务器** - 代理并记录所有 HTTP 请求和响应
- **查看器** - 可视化查看代理记录的请求和响应

## 安装依赖

```bash
bun install
```

## 使用方法

### 使用 `bun start` 启动

默认仍使用 localhost 端口模式，并自动启动 JSON 配置中已启用的代理实例：

```bash
bun start
# 查看器：http://localhost:33000（占用时自动尝试下一个端口）

bun start --port 33001
```

加上 `--portless` 切换到带 HTTPS 证书的命名域名模式：

```bash
bun start --portless
# 查看器：https://proxy.localhost
# 代理实例：https://<实例名>.proxy.localhost

bun start --portless --portless-name my-proxy
# 查看器：https://my-proxy.localhost

bun start --portless --no-open
# 不自动打开浏览器

bun start --portless --lan
# 同时启用局域网 HTTPS
```

Portless 模式会同时提供 `http://localhost:<端口>` 和 HTTPS 域名，两个地址共享同一进程、同一份请求记录；启动日志会打印本地端口。默认会优先使用 `33000`，端口占用时尝试后续端口，也可用 `--port` 指定。要同时使用两种访问方式，只启动一个 `bun start --portless` 即可；不要再单独启动第二个 `bun start`，避免重复启动同一代理实例和并发访问数据库。

例如配置中名为 `llm-lab`、监听 `20002` 的实例，会注册为 `https://llm-lab.proxy.localhost`。
实例域名由 `proxy-config.json` 的 `name` 派生，不需要另写一份配置；不适合作为 DNS 标签的名称会规范化并添加短哈希避免冲突，实际 URL 会打印在启动日志中。实例启动、停止时同步注册、删除域名路由。应用退出只清理自己的路由，不会停止其他项目共用的 Portless 服务。

HTTPS 默认只在本机访问。需要局域网访问时启动 `bun start --portless --lan`；Portless 会改用 `.local` 域名和局域网地址。如果现有 Portless 服务尚未启用 LAN，先执行 `bunx --no-install portless proxy stop` 再启动；这会暂时中断该服务上的其他路由。手机等客户端必须能解析 mDNS，并安装并信任本机 Portless CA（默认 `$HOME/.portless/ca.pem`），否则 HTTPS 证书会报不受信任。Portless HTTPS 是共用服务；启用 LAN 会让该 Portless 服务中的其他已注册路由也能从局域网访问。

Portless 模式需要 **Node.js 24+** 和 OpenSSL，项目本身仍由 Bun 运行。执行 `bun install` 会安装固定版本的 Portless。
首次运行时，Portless 自动生成本地 CA 和 HTTPS 证书，并可能要求系统授权以信任 CA、监听标准 HTTPS 端口 `443` 或更新 hosts 文件。
这只是本地开发证书，不是公网证书，也不会自动将服务暴露到互联网。

如果浏览器提示证书不受信任，可执行：

```bash
bunx --no-install portless trust
bunx --no-install portless doctor
```

某些 API 客户端不使用系统证书存储，需要单独信任本地 CA。例如默认状态目录下可用以下命令验证（不要使用 `curl -k` 或关闭 TLS 校验）：

```bash
curl --cacert "$HOME/.portless/ca.pem" https://proxy.localhost/api/config
```

如已设置 `PORTLESS_STATE_DIR`，请改用该目录内的 `ca.pem`。也可以预先通过 Portless 的 `proxy start --cert /path/to/cert.pem --key /path/to/key.pem` 配置自己的证书；证书必须覆盖查看器和实例子域名。更改已运行的 Portless 服务配置需要手动重启，会影响其他共用该服务的项目。

应用内部依然监听端口，只是不需要在 HTTPS URL 中填写端口。显式 `--port` 会作为内部端口；HTTPS 入口使用标准 443 端口，因此不要设置非标准的 `PORTLESS_PORT`。

### 启动代理服务器

```bash
# 从项目根目录
bun run proxy

# 或在 scripts/proxy 目录下
bun run proxy

# 指定端口
bun run proxy -- -p 8080
```

默认代理端口: `27890`
代理目标: `https://www.88code.org`

### 启动查看器

```bash
# 从项目根目录
bun run viewer

# 或在 scripts/proxy 目录下
bun run viewer
```

查看器地址: `http://localhost:3001`

## 配置管理

- 所有代理实例与转发规则现在存储在当前工作目录下的 `proxy-config.json` 中（运行时会自动创建并维护该文件）。
- 首次启动会在当前目录根据示例数据创建默认配置；你也可以参考 `config/proxy-config.example.json` 手动编写。
- 若需要将配置放到自定义位置，可在启动前设置环境变量 `PROXY_CONFIG_PATH=/path/to/config.json`。
- GUI 中的“实例”和“转发规则”操作都会实时写回该配置文件，方便后续通过 Hooks 或其他工具复用。
- 若需将请求数据库移动到其他目录，可设置 `PROXY_DB_PATH=/data/proxy.db`，便于在不同磁盘或容器内保存请求记录。

## 项目结构

```
scripts/proxy/
├── src/
│   ├── proxy-server.ts   # 代理服务器
│   ├── viewer-server.ts  # 查看器服务器
│   ├── viewer.html       # 查看器页面
│   ├── viewer.ts         # 查看器前端逻辑
│   └── .tmp/             # 代理数据存储（自动生成）
│       └── proxy/
│           └── {requestId}_{timestamp}/
│               ├── metadata.json
│               ├── request.md
│               ├── response.md
│               └── response-body.*
├── package.json
└── tsconfig.json
```

## 数据存储

所有代理的请求和响应会保存在 `src/.tmp/proxy/` 目录中，每个请求一个文件夹，按请求顺序命名。

文件夹命名格式: `{requestId}_{timestamp}`
例如: `00001_2025-11-08T01-37-50-503Z`

每个请求文件夹包含：
- `metadata.json` - 请求/响应元数据
- `request.md` - 请求详情（Markdown 格式）
- `response.md` - 响应详情（Markdown 格式）
- `response-body.*` - 响应体（根据 Content-Type 自动选择扩展名）

## 技术栈

### 代理服务器
- **Bun** - 运行时
- **TypeScript** - 类型安全
- **Node.js APIs** - HTTP/HTTPS 代理（流式转发）

### 查看器
- **Bun** - 运行时和开发服务器（支持 HMR）
- **React 19** - UI 框架
- **TypeScript** - 类型安全
- **Tailwind CSS v4** - 样式
- **shadcn/ui** - UI 组件库

---

This project was created using Bun. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
