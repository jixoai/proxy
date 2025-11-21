import { useState, useEffect } from "react";
import highlightWorkerService from "@/services/highlightWorkerService";

export interface UseHighlightWorkerResult {
  highlightedHTML: string | null;
  highlighting: boolean;
  error: string | null;
}

/**
 * 使用共享的 Highlight Worker 进行语法高亮
 * @param code - 要高亮的代码
 * @param language - 语言类型
 * @param theme - 主题
 */
export function useHighlightWorker(
  code: string,
  language: string,
  theme: string = "github-dark-default"
): UseHighlightWorkerResult {
  const [highlightedHTML, setHighlightedHTML] = useState<string | null>(null);
  const [highlighting, setHighlighting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setHighlighting(true);
    setError(null);

    highlightWorkerService
      .highlight(code, language, theme)
      .then((response) => {
        if (cancelled) return;

        if (response.success) {
          setHighlightedHTML(response.html);
          setError(null);
        } else {
          console.error("Highlight error:", response.error);
          setError(response.error);
        }
        setHighlighting(false);
      })
      .catch((err) => {
        if (cancelled) return;

        console.error("Highlight failed:", err);
        setError(err instanceof Error ? err.message : String(err));
        setHighlighting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);

  return {
    highlightedHTML,
    highlighting,
    error,
  };
}
