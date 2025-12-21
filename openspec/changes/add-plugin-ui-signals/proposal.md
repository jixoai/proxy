# Change: Add Plugin UI Signals And Dynamic Streams

## Why
- 需要让插件通过私有头告诉 UI 显示额外标记与备注
- 需要让插件通过私有头提供动态状态（SSE）用于实时渲染
- 这类能力应具备通用性，便于其它插件复用，而非仅针对保活

## What Changes
- 引入“插件私有头命名空间”：`-x-jixo-proxy-<plugin-name>`
- 插件 UI 信息支持“静态 JSON + 动态 SSE URL”两种方式并可叠加
- Viewer 解析插件 UI 信息并在 RequestList/RequestDetail 渲染
- Viewer 以 EventSource 订阅插件提供的 SSE URL（允许跨域）
- anthropic-ping 作为首个落地：写入保活 hash + UI 预览/备注

## Impact
- Affected specs: plugin-ui-signals (new)
- Affected code: proxy-plugin/private-headers, viewer-server, request UI, anthropic-ping
