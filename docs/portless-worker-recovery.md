# Portless 连接中断与实例无法恢复排查

## 已验证的故障链

请求链是客户端 → Node.js Portless HTTPS → 本地 Bun Worker 实例 → 上游服务。`Local viewer: http://localhost:33000` 只是查看器启动提示，不是错误。

Portless 0.15.6 的 HTTP 转发在本地 `ClientRequest` 发生错误时打印 `Proxy error for <host>: ${err.message}`：

- 本地实例在请求过程中关闭连接时，打印 `socket hang up`。
- Portless 使用 `autoSelectFamily` 依次尝试 `127.0.0.1` 和 `::1`。实测 Node.js v26.4.0 在端口未监听时返回 `AggregateError`，`message` 为空，`code` 为 `ECONNREFUSED`，内部两个错误分别对应 IPv4/IPv6。因此日志只有冒号。单凭该日志不能断言一定是此原因。

修复前的实例健康检查每 10 秒执行一次，先判断 `Date.now() - lastPongTime > 15000`，超过阈值就直接 `terminate()`，没有发送新探针。回归测试将时间推进 60 秒，验证仍能立即回应 ping 的 Worker 被杀掉，甚至没有收到 ping。系统休眠、调试暂停或事件循环长暂停均可触发这一逻辑。

异常处理随后只把 `ProxyManager.worker` 清空，没有通知 `ProxyInstancesManager`；外层仍保留该管理器，Portless 路由也仍指向失效端口，既不自动恢复，重新启动还可能报 `Instance already running`。因此一次中断可能演变成该实例后续请求持续失败。单实例承载全部转发时，看起来就是整个代理卡死。

另一个已确认的问题是配置 schema 会丢弃转发 `timeout` 字段，`toForwardConfigs()` 也没有将其传入 Worker，Worker 配置快照同样遗漏该字段，因此原本已有的超时执行逻辑无法可靠接收到 JSON/UI 配置。

这些是确定的代码缺陷，不代表已还原历史上每一次断线的触发原因。排查时现网本地端口和 HTTPS 入口均能快速响应，不能声称当时整个进程正在卡死。没有修改现网配置、停止现网进程或重放真实业务请求。

## 修复

- 每次主动发送 ping，连续三次探测失败才处置，成功即清零；定时器长暂停后的失败不累计，禁止重叠探测。
- 先注册响应监听，再发送 ping；监听和清理绑定同一个 Worker。旧 Worker 延迟到达的消息、错误及退出事件不能清理新 Worker。
- 异常退出打印实例名和原因，通知外层状态变更，移除实例的 Portless 路由；按 1、2、4、8、16 秒退避重建 Worker，启动成功后重新注册路由。
- 连续恢复失败五次后停止重试；稳定超过一分钟后发生的新故障重新计算恢复预算。手动停止取消排队恢复，失效实例允许手动启动。
- 启动失败由启动调用者处理，不同时启动另一条恢复链；启动时的监听器按原 Worker 清理。
- 保留转发超时配置，自动恢复使用当前管理器保存的转发、请求头和 Hook 配置。不自动重放任何请求，不修改未配置超时的请求语义。

## 验证方式与边界

`bun test ./tests/proxy-manager-health.test.ts` 覆盖休眠误杀、同步 pong、失败计数、长暂停、重叠探测、旧 Worker 隔离、监听清理、恢复去重、退避上限和停止取消。

`bun test ./tests/proxy-worker-recovery.test.ts` 使用真正的 Node.js Portless 0.15.6 HTTP 入口、Bun Worker 和本地上游：正常 POST → 在途 POST 时终止 Worker → 复现 `socket hang up`/502 → 路由移除/404 → 自动重建 → 路由恢复/200。验证原 POST 仅到达上游一次、旧退出事件不影响新实例，以及恢复前后配置超时均保留，超时请求返回 504 后后续请求仍能成功。

集成测试使用随机非特权端口和 `tests` 内临时目录，不需要 sudo，也不操作现网 Portless。它验证的是本地转发和恢复链路，不是完整 TLS/mDNS 链路。原有 `tests/portless.test.ts` 的非标准 HTTPS 端口错误文案断言与现有实现不一致，是本次修改前已有失败，未顺带修改。

## 应用与现场检查

运行中的生产模式 Bun 进程不会自动加载源码修改，应用修复需要重新启动原来的 `bun start --portless --lan` 会话。重启会中断在途请求，应由使用者选择合适时间。

如再次发生，可同时查看 `[ProxyManager]` 的具体异常、实例端口是否仍监听、UI 状态是否变更，以及是否出现重试或恢复上限日志。HTTPS 单独失败而本地端口正常时，应继续排查 Portless/TLS/mDNS，不应直接归因于 Worker。真正的上游长等待、Hook 阻塞、数据库阻塞等仍需各自证据；本修复不宣称消除所有网络错误，也不保证故障瞬间的在途请求成功。
