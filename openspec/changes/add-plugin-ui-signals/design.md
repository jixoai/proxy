# Design: Plugin UI Signals (Tray + Remark) And Dynamic Streams

## 1) Plugin-Scoped Private Headers

### Header Namespace
- Prefix: `-x-jixo-proxy-`
- Plugin scope: `<prefix><plugin-name>`

### Payload Sources
- **Static**: JSON object stored in `<prefix><plugin-name>`
- **Dynamic**: SSE URL stored in `<prefix><plugin-name>-stream`

> 动静结合：若同时存在，先显示静态内容，再订阅动态流，收到 event-data 后替换/更新显示。

### Injection Timing
- 插件可在 request 或 response hook 注入
- 若同一插件在两处都注入，以 response 侧内容为准

## 2) UI Payload Schema (Static Object)

```json
{
  "name": "anthropic-ping",
  "tray": [
    { "icon": "🖤", "description": "保活停止" },
    { "icon": "💗", "description": "保活中" }
  ],
  "remark": "可选，单段 markdown 文本"
}
```

### Tray Rules
- 最多 3 个 icon
- icon 使用 emoji
- description 为单行 markdown，建议 <= 200 字符（或两行展示截断）

### Remark Rules
- markdown 文本，展示在插件汇总 tooltip 内

## 3) Dynamic Stream (SSE)

- 订阅 `<prefix><plugin-name>-stream` 指向的 URL
- `event-data` 返回一份完整“静态对象”结构（同上）
- UI 收到后替换/更新对应插件的显示信息
- 允许跨域 URL（由插件自行提供并负责 CORS）

## 4) UI Rendering

### RequestList - 插件列
- 显示“生效了 N 个插件”
- Tooltip 以插件顺序展示每个插件的 tray + remark

示例渲染结构：
```md
## ${plugin1.name}

- ${plugin1.tray[0].icon}: ${plugin1.tray[0].description}
- ${plugin1.tray[1].icon}: ${plugin1.tray[1].description}
- ${plugin1.tray[2].icon}: ${plugin1.tray[2].description}

${plugin1.remark}

---

## ${plugin2.name}

- ${plugin2.tray[0].icon}: ${plugin2.tray[0].description}
- ${plugin2.tray[1].icon}: ${plugin2.tray[1].description}
- ${plugin2.tray[2].icon}: ${plugin2.tray[2].description}

${plugin2.remark}
```

### RequestList - Tray
- 在请求行额外显示 tray icon（最多 3 个）
- Hover 显示对应 description

### RequestDetail
- 显示 tray + remark（与 RequestList 保持一致）

## 5) Status Hash Use-Case (anthropic-ping)

- anthropic-ping 使用静态对象写入 tray/remark
- 通过 stream URL 动态更新保活状态
- tray icon 用 🖤 标记“停止保活”
- tray 中可包含 hash 相关描述
