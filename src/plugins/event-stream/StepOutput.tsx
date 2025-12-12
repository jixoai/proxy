import { useEffect, useState } from "react";
import { isHighlightValue } from "@/lib/highlighter";
import { formatIntermediateValue } from "./format";
import { cn } from "@/lib/utils";

function escapeHTML(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function StepOutput({ value, className }: { value: unknown; className?: string }) {
  const highlightable = isHighlightValue(value);
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!highlightable) {
      setHtml(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    value
      .toHTML()
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) {
          setHtml(`<pre class="whitespace-pre-wrap text-xs">${escapeHTML(value.toString())}</pre>`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [highlightable, value]);

  if (highlightable) {
    if (loading && !html) {
      return (
        <div className={cn("text-xs", className)}>
          <pre className="whitespace-pre-wrap">{value.toString()}</pre>
        </div>
      );
    }
    if (html) {
      return (
        <div className={cn("text-xs", className)} dangerouslySetInnerHTML={{ __html: html }} />
      );
    }
    return (
      <div className={cn("text-xs", className)}>
        <pre className="whitespace-pre-wrap">{value.toString()}</pre>
      </div>
    );
  }

  return (
    <div className={cn("text-xs", className)}>
      <pre className="whitespace-pre-wrap">{formatIntermediateValue(value)}</pre>
    </div>
  );
}
