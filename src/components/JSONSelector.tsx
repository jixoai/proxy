import { useEffect } from "react";
import { Braces, Layers } from "lucide-react";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import { useIsland } from "@/components/useIsland";

// 优化的 JSON 提取函数（迭代方式）
function extractJSONFromText(text: string): string[] {
  const jsonObjects: string[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    // 跳过非 '{' 字符
    while (i < len && text[i] !== "{") {
      i++;
    }

    if (i >= len) break;

    // 从 '{' 开始尝试提取 JSON
    const startIndex = i;
    let depth = 0;
    let inString = false;
    let escaped = false;

    while (i < len) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        i++;
        continue;
      }

      if (char === "\\" && inString) {
        escaped = true;
        i++;
        continue;
      }

      if (char === '"') {
        inString = !inString;
      } else if (!inString) {
        if (char === "{") {
          depth++;
        } else if (char === "}") {
          depth--;
          if (depth === 0) {
            // 找到完整的 JSON 对象
            const jsonStr = text.substring(startIndex, i + 1);
            try {
              JSON.parse(jsonStr);
              jsonObjects.push(jsonStr);
            } catch {
              // 不是有效的 JSON，忽略
            }
            i++;
            break;
          }
        }
      }

      i++;
    }

    // 如果没有找到闭合的 '}'，跳到下一个 '{'
    if (depth !== 0) {
      i = startIndex + 1;
    }
  }

  return jsonObjects;
}

export function JSONSelector() {
  const { setDialogJSONSnapshot, setJsonDialogOpen } = useProxyViewer();
  const { addTip, removeTip } = useIsland();

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout>;

    const handleSelectionChange = () => {
      // Debounce 300ms
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          removeTip("json-selector");
          return;
        }

        const selectedText = selection.toString();
        if (selectedText.length < 2) {
          removeTip("json-selector");
          return;
        }

        // 提取 JSON
        const jsonObjects = extractJSONFromText(selectedText);
        if (jsonObjects.length === 0) {
          removeTip("json-selector");
          return;
        }

        // 显示 Island 提示
        addTip({
          id: "json-selector",
          icon:
            jsonObjects.length === 1 ? (
              <Braces className="w-5 h-5" />
            ) : (
              <Layers className="w-5 h-5" />
            ),
          text:
            jsonObjects.length === 1
              ? "JSON detected"
              : `${jsonObjects.length} JSONs detected`,
          subtext: "Click to view",
          onClick: () => {
            setDialogJSONSnapshot([...jsonObjects]);
            setJsonDialogOpen(true);
          },
        });
      }, 300);
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mouseup", handleSelectionChange);

    return () => {
      clearTimeout(debounceTimer);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", handleSelectionChange);
      removeTip("json-selector");
    };
  }, [addTip, removeTip, setDialogJSONSnapshot, setJsonDialogOpen]);

  return null; // 这个组件不渲染任何内容，只处理逻辑
}
