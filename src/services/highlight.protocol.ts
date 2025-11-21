export interface HighlightRequest {
  requestId: number;
  code: string;
  lang: string;
  theme: string;
}

export type HighlightResponse =
  | { success: true; requestId: number; html: string }
  | { success: false; requestId: number; error: string };
