import { codeToHtml } from "shiki";
import type {
  HighlightRequest,
  HighlightResponse,
} from "../services/highlight.protocol";

interface SharedWorkerGlobalScopeLike {
  onconnect: ((event: MessageEvent) => void) | null;
}

async function handleHighlight(
  request: HighlightRequest,
): Promise<HighlightResponse> {
  const { requestId, code, lang, theme } = request;

  try {
    const html = await codeToHtml(code, { lang, theme });
    return { success: true, requestId, html };
  } catch (error) {
    return {
      success: false,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const sharedSelf = self as unknown as SharedWorkerGlobalScopeLike;

sharedSelf.onconnect = (event: MessageEvent) => {
  const port = (event as MessageEvent & { ports?: MessagePort[] }).ports?.[0];
  if (!port) return;

  port.onmessage = async (msg: MessageEvent<HighlightRequest>) => {
    const response = await handleHighlight(msg.data);
    port.postMessage(response);
  };

  port.start();
};
