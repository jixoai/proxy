import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tag, ExternalLink as LinkIcon } from "lucide-react";
import { CustomHeadersInput } from "./CustomHeadersInput";
import type { ProxyForward } from "@/types/proxy";
import { ScrollArea } from "@/components/ui/scroll-area";

interface EditForwardDialogProps {
  forward: ProxyForward;
  trigger?: React.ReactNode;
  onUpdated: () => void;
  instanceHeaders?: string | null;
}

const parseHeadersPreview = (raw?: string | null) => {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(obj).map(([key, value]) => [key, String(value)]);
  } catch {
    return [];
  }
};

export function EditForwardDialog({
  forward,
  trigger,
  onUpdated,
  instanceHeaders,
}: EditForwardDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [method, setMethod] = useState("*");
  const [description, setDescription] = useState("");
  const [customHeaders, setCustomHeaders] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName(forward.name);
      setPath(forward.path || "");
      setTargetUrl(forward.target_url || "");
      setMethod(forward.method || "*");
      setDescription(forward.description || "");
      setCustomHeaders(forward.custom_headers || "");
      setError("");
    }
  }, [open, forward]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch(`/api/forwards/${forward.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          target_url: targetUrl,
          description: description || null,
          method: method.trim() || "*",
          path: path || null,
          custom_headers: customHeaders || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to update forward");
      }

      setOpen(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const instanceHeaderEntries = parseHeadersPreview(instanceHeaders);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" variant="outline">
            编辑
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl p-2 *:p-4">
        <form onSubmit={handleSubmit} className="flex h-full flex-col">
          <DialogHeader>
            <DialogTitle>编辑转发规则</DialogTitle>
            <DialogDescription>修改转发配置</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[65vh] overflow-y-auto p-2!">
            <div className="space-y-4  p-2">
              <div className="space-y-2">
                <Label
                  htmlFor="edit-forward-name"
                  className="flex items-center gap-2"
                >
                  <Tag className="w-3.5 h-3.5" />
                  规则名称
                </Label>
                <Input
                  id="edit-forward-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：DeepSeek Chat API"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-forward-method">HTTP 方法（可选）</Label>
                <Input
                  id="edit-forward-method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  placeholder="* 或 GET,POST"
                />
                <p className="text-xs text-muted-foreground">
                  留空或输入 * 表示匹配所有方法；支持使用逗号分隔的多种方法。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-forward-description">
                  规则描述（可选）
                </Label>
                <Input
                  id="edit-forward-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="例如：DeepSeek OpenAI 兼容接口"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-forward-path">路由前缀（可选）</Label>
                <Input
                  id="edit-forward-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/api 或 /v1"
                />
                <p className="text-xs text-muted-foreground">
                  按路径前缀匹配请求，留空时作为默认规则。
                </p>
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="edit-target-url"
                  className="flex items-center gap-2"
                >
                  <LinkIcon className="w-3.5 h-3.5" />
                  目标 URL
                </Label>
                <Input
                  id="edit-target-url"
                  type="url"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://api.example.com"
                  required
                />
              </div>
              {instanceHeaderEntries.length > 0 && (
                <div className="rounded-md border bg-muted/40 p-3 text-xs">
                  <div className="text-sm font-medium text-muted-foreground mb-2">
                    实例全局 Headers（只读）
                  </div>
                  <div className="space-y-1 font-mono">
                    {instanceHeaderEntries.map(([key, value]) => (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="text-muted-foreground">{key}</span>
                        <span className="text-right break-all">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <CustomHeadersInput
                value={customHeaders}
                onChange={setCustomHeaders}
              />
              {error && <div className="text-sm text-destructive">{error}</div>}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "更新中..." : "更新"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
