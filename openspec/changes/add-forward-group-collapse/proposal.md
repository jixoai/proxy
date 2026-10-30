# Change: Add Forward Group Collapse

## Why
- 转发规则按名称分组，但所有组内规则始终展开；不常使用的分组也占据大量高度，定位常用规则需要反复滚动。

## What Changes
- 每个分组标题增加独立的展开/折叠按钮，默认展开；折叠后保留组名、规则数量和整组拖动入口。
- 提供“全部折叠”和“全部展开”，方便快速整理长列表。
- 在浏览器本地按实例名和分组名记住折叠状态，刷新页面和切换实例后仍保留；本地存储不可用时不影响操作。
- 从请求等位置定位规则时，自动展开目标组后再滚动定位。
- 折叠仅影响界面，不修改 JSON 配置、规则启用状态、规则顺序或运行中的代理。

## Impact
- Affected specs: forward-rule-groups (new)
- Affected code: `src/components/ProxyControl/ForwardRulesList.tsx`、必要的界面状态辅助函数和测试。
- 保持现有视觉样式、组间原生拖动和组内 dnd-kit 排序；折叠按钮与拖动操作互不干扰。
- 不引入后端 API、数据库字段或新的依赖。

## Approval
- Approved by the user: 按照建议实施。
