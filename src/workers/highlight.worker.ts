import { codeToHtml } from "shiki";

export type HighlightRequest = {
  requestId: number;
  code: string;
  lang: string;
  theme: string;
};

export type HighlightResponse =
  | { success: true; requestId: number; html: string }
  | { success: false; requestId: number; error: string };

self.onmessage = async (event: MessageEvent<HighlightRequest>): Promise<void> => {
  const { requestId, code, lang, theme } = event.data;

  try {
    const html = await codeToHtml(code, {
      lang,
      theme,
    });

    const response: HighlightResponse = {
      success: true,
      requestId,
      html,
    };

    self.postMessage(response);
  } catch (error) {
    const response: HighlightResponse = {
      success: false,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    };

    self.postMessage(response);
  }
};
