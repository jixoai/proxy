#!/usr/bin/env bun

import { createCodexWasmPlugin, createPlugin } from "./plugin";

export { createCodexWasmPlugin, createPlugin, type CodexWasmPluginOptions } from "./plugin";

export default createPlugin;

if (import.meta.main) {
  throw new Error(
    `[codex-wasm] standalone plugin server mode is not supported: hooks are in-process.`,
  );
}
