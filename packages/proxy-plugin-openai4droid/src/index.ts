#!/usr/bin/env bun
/**
 * @jixo/proxy-plugin-openai4droid
 *
 * Droid 请求重写插件：
 * - Request Hook: 将 Droid-CLI 的 instructions 内联到 input，并替换为 Codex instructions
 */

import { definePlugin } from "@jixo/proxy-plugin";
import { createDroidPlugin } from "./plugin";

// 导出公共 API
export { createDroidPlugin, type DroidPluginOptions } from "./plugin";

// 作为独立进程运行时启动服务器
if (import.meta.main) {
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  definePlugin(createDroidPlugin({ debug }), { debug });
}
