#!/usr/bin/env bun

import { createCodexPlugin, createPlugin } from "./plugin";

export { createCodexPlugin, createPlugin, type CodexPluginOptions } from "./plugin";

export default createPlugin;

if (import.meta.main) {
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  void debug;
  throw new Error(
    `[codex] standalone plugin server mode is no longer supported: hooks are now in-process and streaming-native.`,
  );
}

