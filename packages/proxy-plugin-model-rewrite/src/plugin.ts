import type {
  PluginLogger,
  PrecheckResult,
  ProxyPlugin,
  RequestHookParams,
  RequestHookResult,
  RequestMeta,
  ResponseMeta,
} from "@jixo/proxy-plugin";
import {
  createLogger,
  normalizeHeaders,
  readStreamToText,
  safeParseJson,
  streamFromBuffer,
} from "@jixo/proxy-plugin";

export type ModelRewriteConfig = string | Record<string, string>;

export interface ModelRewritePluginOptions {
  debug?: boolean;
  logDir?: string;
  model?: ModelRewriteConfig;
}

type RewriteTarget = {
  getModel: (payload: Record<string, unknown>) => string | undefined;
  setModel: (payload: Record<string, unknown>, model: string) => Record<string, unknown>;
  path: string;
};

type RewriteResult = {
  modified: boolean;
  payload: unknown;
  originalModel?: string;
  rewrittenModel?: string;
  targetPath?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRegexRule(pattern: string): RegExp | null {
  if (!pattern.startsWith("/")) return null;
  const lastSlash = pattern.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  const source = pattern.slice(1, lastSlash);
  const flags = pattern.slice(lastSlash + 1);
  if (!source) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function rewriteModelValue(model: string, config: ModelRewriteConfig): string {
  if (typeof config === "string") {
    return config;
  }

  for (const [pattern, replacement] of Object.entries(config)) {
    if (pattern === "*") {
      return replacement;
    }

    const regex = parseRegexRule(pattern);
    if (regex) {
      if (regex.test(model)) {
        return model.replace(regex, replacement);
      }
      continue;
    }

    if (model === pattern) {
      return replacement;
    }
  }

  return model;
}

function getRewriteTargets(payload: Record<string, unknown>): RewriteTarget[] {
  const targets: RewriteTarget[] = [
    {
      getModel: (value) => (typeof value.model === "string" ? value.model : undefined),
      setModel: (value, model) => ({ ...value, model }),
      path: "model",
    },
  ];

  if (payload.type === "response.create" && isRecord(payload.response)) {
    targets.push({
      getModel: (value) => {
        const response = value.response;
        return isRecord(response) && typeof response.model === "string" ? response.model : undefined;
      },
      setModel: (value, model) => ({
        ...value,
        response: {
          ...(value.response as Record<string, unknown>),
          model,
        },
      }),
      path: "response.model",
    });
  }

  return targets;
}

export function rewritePayloadModel(
  payload: unknown,
  config: ModelRewriteConfig | undefined,
): RewriteResult {
  if (!config || !isRecord(payload)) {
    return { modified: false, payload };
  }

  for (const target of getRewriteTargets(payload)) {
    const originalModel = target.getModel(payload);
    if (!originalModel) continue;

    const rewrittenModel = rewriteModelValue(originalModel, config);
    if (rewrittenModel === originalModel) {
      continue;
    }

    return {
      modified: true,
      payload: target.setModel(payload, rewrittenModel),
      originalModel,
      rewrittenModel,
      targetPath: target.path,
    };
  }

  return { modified: false, payload };
}

export function createModelRewritePlugin(
  options: ModelRewritePluginOptions = {},
): ProxyPlugin {
  const { debug, logDir, model } = options;

  const logger: PluginLogger = createLogger({
    name: "model-rewrite",
    debug,
    logDir,
  });

  return {
    name: "model-rewrite",

    shouldProcessRequest(meta: RequestMeta): PrecheckResult {
      if (!model) {
        return false;
      }
      const headers = normalizeHeaders(meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();
      return contentType.includes("application/json");
    },

    shouldProcessResponse(_meta: ResponseMeta): PrecheckResult {
      return false;
    },

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
      if (!model) {
        return null;
      }

      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();
      if (!contentType.includes("application/json")) {
        return null;
      }

      const bodyText = await readStreamToText(params.body);
      const parsed = safeParseJson<unknown>(bodyText);
      if (parsed === null) {
        return null;
      }

      const result = rewritePayloadModel(parsed, model);
      if (!result.modified) {
        return null;
      }

      logger.debug(
        `Rewrote ${result.targetPath ?? "model"}: ${result.originalModel ?? "unknown"} -> ${result.rewrittenModel ?? "unknown"}`,
      );

      if (debug) {
        logger.logToFile("request-rewrite", {
          method: params.meta.method,
          url: params.meta.url,
          targetPath: result.targetPath,
          originalModel: result.originalModel,
          rewrittenModel: result.rewrittenModel,
        });
      }

      return {
        body: streamFromBuffer(Buffer.from(JSON.stringify(result.payload), "utf-8")),
      };
    },
  };
}

export function createPlugin(options: ModelRewritePluginOptions = {}): ProxyPlugin {
  return createModelRewritePlugin(options);
}
