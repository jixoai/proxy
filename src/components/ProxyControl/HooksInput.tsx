import { useState, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Info, ChevronDown, Zap } from "lucide-react";
import type { HooksConfig } from "@/types/proxy";

interface HooksInputProps {
  value: string; // JSON string
  onChange: (value: string) => void;
}

const EXAMPLE_HOOKS: HooksConfig = [
  {
    type: "http",
    command: "bunx",
    args: ["@jixo/proxy-plugin-droid"],
  },
];

export function HooksInput({ value, onChange }: HooksInputProps) {
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!value || value.trim() === "") {
      setJsonText("");
      setJsonError(null);
      setIsOpen(false);
      return;
    }

    try {
      const parsed = JSON.parse(value);
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError(null);
      setIsOpen(true);
    } catch (error) {
      setJsonText(value);
      setJsonError("JSON 解析失败");
    }
  }, [value]);

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    if (!text.trim()) {
      setJsonError(null);
      onChange("");
      return;
    }

    try {
      const parsed = JSON.parse(text);
      onChange(JSON.stringify(parsed));
      setJsonError(null);
    } catch {
      setJsonError("JSON 解析失败：请检查格式");
    }
  };

  const insertExample = () => {
    const text = JSON.stringify(EXAMPLE_HOOKS, null, 2);
    setJsonText(text);
    onChange(JSON.stringify(EXAMPLE_HOOKS));
    setJsonError(null);
  };

  const hasValue = value && value.trim() !== "";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 text-sm font-medium hover:underline"
        >
          <Zap className="h-3.5 w-3.5" />
          Hooks 配置
          <ChevronDown
            className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
          />
          {hasValue && !isOpen && (
            <span className="text-muted-foreground text-xs font-normal">(已配置)</span>
          )}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center"
            >
              <Info className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-xs leading-relaxed">
            <p className="mb-2">配置插件，用于在转发前后处理请求和响应。</p>
            <p className="mb-1">
              <strong>格式：</strong> 单个插件或插件数组
            </p>
            <pre className="bg-muted rounded p-1 text-[10px]">
              {`[
  {
    "type": "http",
    "command": "bunx",
    "args": ["@jixo/proxy-plugin-xxx"],
    "config": { ... }
  }
]`}
            </pre>
            <p className="mt-2 mb-1">
              <strong>插件配置字段：</strong>
            </p>
            <ul className="list-inside list-disc space-y-0.5">
              <li>type: "http"</li>
              <li>command: 启动命令</li>
              <li>args: 命令参数数组</li>
              <li>config: 插件配置（可选）</li>
            </ul>
          </TooltipContent>
        </Tooltip>
      </div>
      {isOpen && (
        <div className="space-y-2">
          <Textarea
            value={jsonText}
            onChange={(e) => handleJsonChange(e.target.value)}
            placeholder="留空表示不使用 hooks"
            className="font-mono text-xs"
            rows={8}
          />
          {jsonError ? (
            <p className="text-destructive text-xs">{jsonError}</p>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-xs">
                配置插件来处理请求和响应，每个插件同时作为 request 和 response hook。
              </p>
              <button
                type="button"
                onClick={insertExample}
                className="text-muted-foreground hover:text-foreground text-xs underline"
              >
                插入示例
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
