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

- 所有代理实例与转发规则现在存储在 `config/proxy-config.json` 中（运行时自动生成并维护）。
- 首次启动会根据示例数据创建默认配置；你也可以参考 `config/proxy-config.example.json` 手动编写。
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
