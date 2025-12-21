import type { ReactNode } from "react";

function renderMarkdownLines(markdown: string): ReactNode[] {
  const lines = markdown.split("\n");
  const nodes: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    nodes.push(
      <ul key={`list-${nodes.length}`} className="list-disc space-y-1 pl-4 text-xs">
        {listItems.map((item, index) => (
          <li key={`li-${index}`}>{item}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      flushList();
      continue;
    }

    if (line === "---") {
      flushList();
      nodes.push(<div key={`hr-${nodes.length}`} className="my-2 h-px bg-border" />);
      continue;
    }

    if (line.startsWith("## ")) {
      flushList();
      nodes.push(
        <div key={`h-${nodes.length}`} className="mt-2 text-xs font-semibold">
          {line.slice(3)}
        </div>,
      );
      continue;
    }

    if (line.startsWith("- ")) {
      listItems.push(line.slice(2));
      continue;
    }

    flushList();
    nodes.push(
      <div key={`t-${nodes.length}`} className="text-xs leading-relaxed">
        {line}
      </div>,
    );
  }

  flushList();
  return nodes;
}

export function PluginUiMarkdown({ markdown }: { markdown: string }) {
  return <div className="space-y-2">{renderMarkdownLines(markdown)}</div>;
}
