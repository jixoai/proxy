#!/usr/bin/env bun

import { createModelRewritePlugin, createPlugin } from "./plugin";

export {
  createModelRewritePlugin,
  createPlugin,
  type ModelRewriteConfig,
  type ModelRewritePluginOptions,
} from "./plugin";

export default createPlugin;

if (import.meta.main) {
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  void debug;
  throw new Error(
    `[model-rewrite] standalone plugin server mode is no longer supported: hooks are now in-process and streaming-native.`,
  );
}
