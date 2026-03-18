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

const RESPONSES_PATH_RE = /\/responses(?:[/?]|$)/i;

export interface CodexPluginOptions {
  debug?: boolean;
  logDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function shouldHandleUrl(url: string | undefined): boolean {
  if (!url) {
    return true;
  }
  return RESPONSES_PATH_RE.test(url);
}

type StripResult = {
  modified: boolean;
  payload: unknown;
  removedTopLevel: boolean;
  removedResponseCreate: boolean;
  removedIncludeTopLevel: boolean;
  removedIncludeResponseCreate: boolean;
};

function stripPromptCacheKey(payload: unknown): StripResult {
  if (!isRecord(payload)) {
    return {
      modified: false,
      payload,
      removedTopLevel: false,
      removedResponseCreate: false,
      removedIncludeTopLevel: false,
      removedIncludeResponseCreate: false,
    };
  }

  let removedTopLevel = false;
  let removedResponseCreate = false;
  let removedIncludeTopLevel = false;
  let removedIncludeResponseCreate = false;
  let nextPayload = payload;

  if (hasOwn(nextPayload, "prompt_cache_key")) {
    nextPayload = { ...nextPayload };
    delete nextPayload.prompt_cache_key;
    removedTopLevel = true;
  }
  if (hasOwn(nextPayload, "include")) {
    if (nextPayload === payload) {
      nextPayload = { ...nextPayload };
    }
    delete nextPayload.include;
    removedIncludeTopLevel = true;
  }

  if (
    nextPayload.type === "response.create" &&
    isRecord(nextPayload.response) &&
    (hasOwn(nextPayload.response, "prompt_cache_key") || hasOwn(nextPayload.response, "include"))
  ) {
    const nextResponse = { ...nextPayload.response };
    if (hasOwn(nextResponse, "prompt_cache_key")) {
      delete nextResponse.prompt_cache_key;
      removedResponseCreate = true;
    }
    if (hasOwn(nextResponse, "include")) {
      delete nextResponse.include;
      removedIncludeResponseCreate = true;
    }
    nextPayload = { ...nextPayload, response: nextResponse };
  }

  return {
    modified:
      removedTopLevel ||
      removedResponseCreate ||
      removedIncludeTopLevel ||
      removedIncludeResponseCreate,
    payload: nextPayload,
    removedTopLevel,
    removedResponseCreate,
    removedIncludeTopLevel,
    removedIncludeResponseCreate,
  };
}

export function createCodexPlugin(options: CodexPluginOptions = {}): ProxyPlugin {
  const { debug, logDir } = options;

  const logger: PluginLogger = createLogger({
    name: "codex",
    debug,
    logDir,
  });

  return {
    name: "codex",

    shouldProcessRequest(meta: RequestMeta): PrecheckResult {
      const headers = normalizeHeaders(meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();
      if (!contentType.includes("application/json")) {
        return false;
      }
      return shouldHandleUrl(meta.url);
    },

    shouldProcessResponse(_meta: ResponseMeta): PrecheckResult {
      return false;
    },

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
      const headers = normalizeHeaders(params.meta.headers) ?? {};
      const contentType = (headers["content-type"] ?? "").toString().toLowerCase();
      if (!contentType.includes("application/json")) {
        return null;
      }
      if (!shouldHandleUrl(params.meta.url)) {
        return null;
      }

      const bodyText = await readStreamToText(params.body);
      const parsed = safeParseJson<unknown>(bodyText);
      if (parsed === null) {
        return null;
      }

      const result = stripPromptCacheKey(parsed);
      if (!result.modified) {
        return null;
      }

      if (debug) {
        logger.logToFile("request-rewrite", {
          method: params.meta.method,
          url: params.meta.url,
          removedTopLevel: result.removedTopLevel,
          removedResponseCreate: result.removedResponseCreate,
          removedIncludeTopLevel: result.removedIncludeTopLevel,
          removedIncludeResponseCreate: result.removedIncludeResponseCreate,
        });
      }

      logger.debug(
        `Removed fields prompt_cache_key/include: top=${String(result.removedTopLevel || result.removedIncludeTopLevel)} response_create=${String(result.removedResponseCreate || result.removedIncludeResponseCreate)}`,
      );

      return {
        body: streamFromBuffer(Buffer.from(JSON.stringify(result.payload), "utf-8")),
      };
    },
  };
}

export function createPlugin(options: CodexPluginOptions = {}): ProxyPlugin {
  return createCodexPlugin(options);
}
