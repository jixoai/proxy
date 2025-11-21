import { useMemo, memo } from "react";
import { useHighlightWorker } from "@/hooks/useHighlightWorker";
import { LoaderCircle } from "lucide-react";

export interface HighlighterProps {
  code: string;
  language: string;
  theme?: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 通用的代码高亮组件，使用共享的 WebWorker (Shiki) 进行语法高亮
 */
const HighlighterInner = ({
  code,
  language,
  theme = "github-dark-default",
  className = "",
  style = {},
}: HighlighterProps) => {
  const { highlightedHTML, highlighting, error } = useHighlightWorker(
    code,
    language,
    theme,
  );

  // 使用 useMemo 缓存渲染结果，避免不必要的重新渲染
  const renderedContent = useMemo(() => {
    if (highlightedHTML) {
      return (
        <div
          dangerouslySetInnerHTML={{ __html: highlightedHTML }}
          className={`*:p-2 shiki-container ${className} *:whitespace-break-spaces **:text-xs`}
          style={{ margin: 0, fontSize: "0.875rem", ...style }}
        />
      );
    }
    return (
      <div className={`bg-muted relative ${className}`} style={style}>
        {error ? (
          <div className="bg-destructive/10 text-destructive text-xs px-3 py-2 border-b border-destructive/20">
            Highlight failed: {error}
          </div>
        ) : highlighting ? (
          <div className="absolute inset-0">
            <div className="flex flex-row items-center justify-center gap-2 mt-1 text-muted-foreground">
              <LoaderCircle className="animate-spin size-4" />
              <span className="text-xs">Highlighting code...</span>
            </div>
          </div>
        ) : null}

        <pre className="p-2 text-xs whitespace-break-spaces">
          <code>{code}</code>
        </pre>
      </div>
    );
  }, [highlighting, error, highlightedHTML, code, className, style]);

  return renderedContent;
};

// 使用 memo 优化，只在 props 真正变化时才重新渲染
export const Highlighter = memo(HighlighterInner, (prevProps, nextProps) => {
  return (
    prevProps.code === nextProps.code &&
    prevProps.language === nextProps.language &&
    prevProps.theme === nextProps.theme &&
    prevProps.className === nextProps.className
  );
});
