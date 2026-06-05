import type {
  PrecheckResult,
  ProxyPlugin,
  RequestHookParams,
  RequestHookResult,
  RequestMeta,
  ResponseHookParams,
  ResponseHookResult,
  ResponseMeta,
} from "@jixo/proxy-plugin";
import { createLogger, normalizeHeaders } from "@jixo/proxy-plugin";

const RESPONSES_PATH_RE = /\/responses(?:[/?]|$)/i;

const BROWSER_HEADERS_TO_STRIP = [
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "origin",
  "referer",
  "accept-encoding",
  "accept-language",
];

const CODEX_TUI_USER_AGENT =
  "codex-tui/0.131.0 (Mac OS 15.6.1; arm64) Apple_Terminal/455.1 (codex-tui; 0.131.0)";

export interface CodexWasmPluginOptions {
  debug?: boolean;
  logDir?: string;
}

function isBrowserRequest(headers: Record<string, string | string[]>): boolean {
  const ua = (headers["user-agent"] ?? "").toString();
  return ua.includes("Mozilla/") || ua.includes("Chrome/");
}

export function createCodexWasmPlugin(options: CodexWasmPluginOptions = {}): ProxyPlugin {
  const { debug, logDir } = options;
  const logger = createLogger({ name: "codex-wasm", debug, logDir });

  return {
    name: "codex-wasm",

    shouldProcessRequest(meta: RequestMeta): PrecheckResult {
      if (meta.method === "OPTIONS") {
        return true;
      }
      const headers = normalizeHeaders(meta.headers) ?? {};
      if (!isBrowserRequest(headers)) {
        return false;
      }
      return RESPONSES_PATH_RE.test(meta.url || "");
    },

    shouldProcessResponse(meta: ResponseMeta, requestMeta?: RequestMeta): PrecheckResult {
      if (!requestMeta) return false;
      const headers = normalizeHeaders(requestMeta.headers) ?? {};
      if (!isBrowserRequest(headers)) {
        return false;
      }
      return RESPONSES_PATH_RE.test(requestMeta.url || "");
    },

    async onRequest(params: RequestHookParams): Promise<RequestHookResult | null> {
      const headers = normalizeHeaders(params.meta.headers) ?? {};

      // OPTIONS preflight: respond locally
      if (params.meta.method === "OPTIONS") {
        logger.debug("Handling OPTIONS preflight locally");
        return {
          respondWith: {
            statusCode: 204,
            headers: {
              "access-control-allow-origin": (headers["origin"] as string) || "*",
              "access-control-allow-methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
              "access-control-allow-headers":
                (headers["access-control-request-headers"] as string) || "*",
              "access-control-max-age": "86400",
            },
          },
        };
      }

      // Not a browser request — skip
      if (!isBrowserRequest(headers)) {
        return null;
      }

      // Strip browser-specific headers and align with terminal codex
      const newHeaders: Record<string, string | string[]> = { ...headers };

      for (const h of BROWSER_HEADERS_TO_STRIP) {
        delete newHeaders[h];
      }

      // Replace User-Agent
      newHeaders["user-agent"] = CODEX_TUI_USER_AGENT;

      // Add originator if missing
      if (!newHeaders["originator"]) {
        newHeaders["originator"] = "codex-tui";
      }

      logger.debug("Rewrote browser headers to match terminal codex");

      return {
        meta: { headers: newHeaders },
      };
    },

    async onResponse(params: ResponseHookParams): Promise<ResponseHookResult | null> {
      // Add CORS headers to response so browser can read it
      const headers = { ...(params.meta.headers || {}) };
      headers["access-control-allow-origin"] = "*";
      headers["access-control-expose-headers"] = "*";

      return {
        meta: { headers },
      };
    },
  };
}

export function createPlugin(options: CodexWasmPluginOptions = {}): ProxyPlugin {
  return createCodexWasmPlugin(options);
}
