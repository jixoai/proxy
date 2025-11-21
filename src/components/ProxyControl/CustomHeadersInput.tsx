import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Plus, Trash2, Info } from "lucide-react";

interface HeaderRow {
  key: string;
  value: string;
}

interface CustomHeadersInputProps {
  value: string; // JSON string
  onChange: (value: string) => void;
}

export function CustomHeadersInput({
  value,
  onChange,
}: CustomHeadersInputProps) {
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [mode, setMode] = useState<"table" | "json">("table");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  // 把外部的 JSON 字符串同步到本地行 / JSON 文本
  useEffect(() => {
    if (!value || value.trim() === "") {
      setHeaders([]);
      setJsonText("");
      setJsonError(null);
      return;
    }

    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const rows: HeaderRow[] = Object.entries(parsed).map(([key, val]) => ({
        key,
        value: String(val),
      }));
      setHeaders(rows);
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError(null);
    } catch (error) {
      console.error("Failed to parse custom headers:", error);
      setHeaders([]);
      setJsonText(value);
      setJsonError("JSON 解析失败，仅在 JSON 模式下生效");
    }
  }, [value]);

  // 将行数据同步到外部 JSON 字符串
  const updateParentFromRows = (rows: HeaderRow[]) => {
    if (rows.length === 0) {
      onChange("");
      return;
    }

    const obj: Record<string, string> = {};
    rows.forEach((row) => {
      if (row.key.trim()) {
        obj[row.key.trim()] = row.value;
      }
    });

    const json = JSON.stringify(obj);
    onChange(json);
    setJsonText(JSON.stringify(obj, null, 2));
    setJsonError(null);
  };

  const addRow = () => {
    const newHeaders = [...headers, { key: "", value: "" }];
    setHeaders(newHeaders);
  };

  const removeRow = (index: number) => {
    const newHeaders = headers.filter((_, i) => i !== index);
    setHeaders(newHeaders);
    updateParentFromRows(newHeaders);
  };

  const updateRow = (index: number, field: "key" | "value", val: string) => {
    const newHeaders = [...headers];
    const header = newHeaders[index];
    if (header) {
      header[field] = val;
    }
    setHeaders(newHeaders);
    updateParentFromRows(newHeaders);
  };

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    if (!text.trim()) {
      setJsonError(null);
      onChange("");
      setHeaders([]);
      return;
    }

    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const rows: HeaderRow[] = Object.entries(parsed).map(([key, val]) => ({
        key,
        value: String(val),
      }));
      setHeaders(rows);
      onChange(JSON.stringify(parsed));
      setJsonError(null);
    } catch (error) {
      setJsonError("JSON 解析失败：请检查格式（例如引号、逗号等）");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1">
          自定义 Headers
        </Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center"
            >
              <Info className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs leading-relaxed">
            <p className="mb-1">
              支持使用 JSON 形式编辑 Headers，也可以在表格模式中逐行编辑。
            </p>
            <p className="mb-1">
              特殊语法：
              <br />- 值设置为 <code>/DELETE</code> 表示删除匹配的 Header。
              <br />- 键可以使用正则表达式，例如 <code>/^x-foo-.*/</code>{" "}
              用于批量匹配。
            </p>
          </TooltipContent>
        </Tooltip>
      </div>

      <Tabs value={mode} onValueChange={(v) => setMode(v as "table" | "json")}>
        <TabsList>
          <TabsTrigger value="table">表格模式</TabsTrigger>
          <TabsTrigger value="json">JSON 模式</TabsTrigger>
        </TabsList>
        <TabsContent value="table" className="mt-2 space-y-2">
          {headers.length === 0 ? (
            <div className="text-sm text-muted-foreground py-2">
              暂无自定义 Header，点击下方按钮添加。
            </div>
          ) : (
            <div className="space-y-2">
              {headers.map((row, index) => (
                <div key={index} className="flex gap-2 items-center">
                  <Input
                    placeholder="Header Name"
                    value={row.key}
                    onChange={(e) => updateRow(index, "key", e.target.value)}
                    className="flex-1"
                  />
                  <Input
                    placeholder="Header Value"
                    value={row.value}
                    onChange={(e) => updateRow(index, "value", e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRow(index)}
                    className="shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            className="w-full"
          >
            <Plus className="w-4 h-4 mr-2" />
            添加 Header
          </Button>
        </TabsContent>
        <TabsContent value="json" className="mt-2 space-y-2">
          <Textarea
            value={jsonText}
            onChange={(e) => handleJsonChange(e.target.value)}
            placeholder='例如：{ "Authorization": "Bearer xxx" }'
            className="font-mono text-xs"
            rows={6}
          />
          {jsonError ? (
            <p className="text-xs text-destructive">{jsonError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              JSON 对象的每个字段都会被视作一个 Header。键为 Header 名，值为
              Header 值。
            </p>
          )}
        </TabsContent>
      </Tabs>

      <p className="text-xs text-muted-foreground">
        这些 Headers 会在转发请求时附加或修改请求头，可用于注入认证信息、移除敏感 Header 等。
      </p>
    </div>
  );
}

