## Context And Local Findings
- `src/proxy-server.ts` 当前先构建候选，再读取请求体；模型能力筛选需要在取得请求模型后、首次上游请求前完成。
- 现有每次 HTTP 尝试已经从 `originalRequestBody` 初始化，新增重写必须保留这一隔离，不把上一 provider 改写后的模型用于下一次选择。
- `packages/proxy-plugin-model-rewrite/src/plugin.ts` 已支持固定名、精确映射、通配和正则；这是重写能力，不是 provider 选择能力。
- 现有转换插件使用 `x-target-model` 覆盖目标模型；新增映射不能被这个旧固定值悄悄覆盖。
- 当前还存在 `/droid` 到 `/anthropic` 的特定别名回退，需要保持它的明确转换语义，不能把“没有兼容 provider”当成进入任意其他组的理由。
- WebSocket 升级处理独立于 HTTP hooks，模型往往在升级后的消息中才出现；HTTP 模型路由不能冒充已经支持 WebSocket 消息级调度。

## Proposed Configuration
在一条 provider 规则上增加：

```json
{
  "name": "glm",
  "target": "https://provider.example/v1",
  "models": ["glm-5.3", "glm-5.3-flash"],
  "modelMapping": {
    "local-glm": "glm-5.3",
    "local-fast": "glm-5.3-flash"
  },
  "apiFormats": ["responses", "anthropic-messages"],
  "modelApiFormats": {
    "glm-5.3-flash": ["anthropic-messages"]
  }
}
```

- `models?: string[]`：provider 的目标模型名称；按 provider 映射后的模型匹配。省略、`null` 或空数组统一表示全部支持，不表示禁用。名称采用精确、区分大小写匹配，去除配置项两端空白并去重。
- `modelMapping?: Record<string, string>`：客户端模型名到该 provider 目标模型名的精确映射，允许多个客户端别名映射同一目标。省略、`null`、空对象或未命中时不新增重写。首期不加入正则和通配，避免和旧插件产生两套模糊匹配优先级。
- `apiFormats?: ApiFormat[]`：provider 可接受的客户端协议。支持 `responses`、`anthropic-messages`、`chat-completions`；省略、`null` 或空数组表示不限制。禁用仍使用 `enabled: false`。
- `modelApiFormats?: Record<string, ApiFormat[]>`：以目标模型名为键的可选细分限制。省略或空数组不增加限制；同时配置 provider 和模型限制时取交集，避免某个模型行意外绕过 provider 限制。
- 映射、模型列表和 API 能力独立：只配置映射不限制其他未映射模型；只配置 API 不要求填写模型；只配置模型不要求映射或 API。
- 示例：不配置 `models`，仅将 `local-fast` 映射到 `glm-5.3-flash`，则其他模型仍按原名参与该 provider 的路由。

## Request Selection And Rewrite
1. 保持现有 method/path 分组匹配与启用过滤；不要因为模型不支持而选择另一个无关分组。
2. 读取原始 body 后提取字符串 `model`，只解析一次请求选择所需的 JSON；按客户端原始路由识别 API。Responses 的 compact、Messages 的 count_tokens 属于对应协议族，通用/未知路由不凭 JSON 字段猜测 API。
3. 为每个候选单独计算映射目标，以目标名检查显式 `models`，以原始请求协议检查 `apiFormats` 和该目标的 `modelApiFormats`；保留兼容候选的原有排序。
4. 对每次尝试，重新使用原始 body 和当前 provider 的映射；新增映射在 hook 前提供目标模型，hook 转换后确保显式映射目标仍生效。没有命中新映射时保留旧 hooks 的既有语义，不额外重写。
5. 新映射命中时，该映射优先于旧 `x-target-model` 固定值及模型重写 hook；编辑界面提示清理重复的旧设置。协议转换 hooks 仍照常处理 URL、请求结构、响应及 SSE。
6. 对于旧 hook 单独改写模型的配置，在首次实际发送前以最终模型复核显式模型限制；不符合时跳过该尝试。只靠新映射的路由不需要启动不兼容 provider 的 hooks 来试错。
7. 保持既有超时、客户端断开取消、流式响应及失败回退规则。已向客户端发送流数据后，不进行跨 provider 重试。
8. 保持既有 `/droid` 别名回退，分别检查实际 transport provider 的模型能力及该尝试结合来源 hooks 后的有效客户端 API 能力。新增过滤不得绕过其转换 hooks 或变成一般性的跨组回退。

## Errors And Non-LLM Requests
- 显式模型限制存在而请求没有有效字符串模型时，该 provider 不作为模型请求的候选；所有候选均无法解析需要的模型时返回 400，说明缺少模型或请求 JSON 无效，不把未解析 body 当作任意模型放行。
- 全部启用候选均因模型/API 不兼容被排除时，返回 HTTP 422，错误码 `no_compatible_provider`，包含分组、请求模型、识别的 API 和简短原因；不暴露密钥、认证头或完整 body。
- 没有 body 的 GET、模型列表查询和未知通用代理请求不因模型列表而被拒绝，不重写其内容；已识别的 API 仍遵守 API 限制。
- 未配置任何能力和映射的普通代理保持原有透传行为；不为该功能增加第三方探测、网络依赖或强制协议校验。
- WebSocket 如果匹配组涉及显式非空的新能力限制或映射，升级前返回明确的“不支持此配置下的 WebSocket 模型路由”错误，避免用户误以为已正确路由；无新配置时保持原有升级路径。完整 WebSocket 调度另立提案。

## Configuration And UI
- JSON 是唯一配置真相，全部新字段需贯穿 schema、保存/加载、实例运行时配置、worker reload、配置对比与运行快照，避免被裁剪或热更新遗漏。
- provider 编辑中提供“模型与 API（可选）”区域：模型列表、客户端别名到目标名称映射、provider API 多选、模型 API 细分；模型和映射可独立添加或清空。
- 空配置明确展示“全部模型 / API 不限制 / 模型原名透传”；新增和编辑对话框保持一致。
- 支持在不填写模型的情况下只添加映射；删除最后一条支持模型后恢复全部支持，保存前文字明确提示这一语义。
- 列表以简短摘要展示“全部模型”或模型数量、映射数量与协议限制，不把折叠分组重新变成长表格。

## Verification
- 纯函数覆盖默认全支持、空值归一化、精确映射、多个别名、未命中透传、按目标名筛选、API 交集、未知端点与错误原因。
- 使用本地 mock 上游验证 `glm-5.3` / `glm-5.3-flash`、按模型和 API 跳过不兼容 provider、排序和失败回退、原始 body 隔离、没有兼容候选时零上游调用。
- 结合已有转换 hook 验证映射优先级、协议能力含义、count_tokens / compact、别名回退和 SSE 不被破坏。
- 覆盖 JSON round-trip、worker reload/快照，以及缺省与显式空配置。
- 浏览器验证新增/编辑/清空和摘要，并回归分组折叠；执行 `bun ts` 与相关测试。

## Non-Goals
- 不自动从 `/models` 同步能力，不硬编码供应商/商业模型知识。
- 不根据响应失败永久关闭 provider，不重写现有负载分配策略。
- 不自动进行 Responses / Messages / Chat Completions 协议转换，不实现 WebSocket 消息级调度。
