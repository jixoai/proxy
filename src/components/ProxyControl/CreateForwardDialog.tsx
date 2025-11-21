import { useState } from "react";
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
import { Plus, Tag, ExternalLink as LinkIcon } from "lucide-react";
import { CustomHeadersInput } from "./CustomHeadersInput";
import { ScrollArea } from "@/components/ui/scroll-area";

interface CreateForwardDialogProps {
  instanceId: number;
  trigger?: React.ReactNode;
  onCreated: () => void;
}

export function CreateForwardDialog({
  instanceId,
  trigger,
  onCreated,
}: CreateForwardDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [method, setMethod] = useState("*");
  const [description, setDescription] = useState("");
  const [customHeaders, setCustomHeaders] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/forwards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instance_id: instanceId,
          name,
          target_url: targetUrl,
          enabled: true,
          path: path || null,
          description: description || null,
          method: method.trim() || "*",
          custom_headers: customHeaders || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to create forward");
      }

      setOpen(false);
      setName("");
      setPath("");
      setTargetUrl("");
      setMethod("*");
      setDescription("");
      setCustomHeaders("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" variant="outline">
            <Plus className="w-3 h-3 mr-1" />
            添加转发
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl p-2 *:p-4">
        <form onSubmit={handleSubmit} className="flex h-full flex-col">
          <DialogHeader>
            <DialogTitle>添加转发规则</DialogTitle>
            <DialogDescription>配置请求转发到目标服务器</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[65vh] overflow-y-auto p-2!">
            <div className="space-y-4 p-2">
              <div className="space-y-2">
                <Label
                  htmlFor="forward-name"
                  className="flex items-center gap-2"
                >
                  <Tag className="w-3.5 h-3.5" />
                  规则名称
                </Label>
                <Input
                  id="forward-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：DeepSeek Chat"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="forward-method">HTTP 方法（可选）</Label>
                <Input
                  id="forward-method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  placeholder="* 或 GET,POST"
                />
                <p className="text-xs text-muted-foreground">
                  留空或输入 * 表示匹配所有方法；支持使用逗号分隔多个方法，例如
                  GET,POST。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="forward-description">规则描述（可选）</Label>
                <Input
                  id="forward-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="例如：DeepSeek OpenAI 兼容接口"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="forward-path">路由前缀（可选）</Label>
                <Input
                  id="forward-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/api 或 /v1"
                />
                <p className="text-xs text-muted-foreground">
                  按路径前缀匹配请求，留空时作为默认规则。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="target-url" className="flex items-center gap-2">
                  <LinkIcon className="w-3.5 h-3.5" />
                  目标 URL
                </Label>
                <Input
                  id="target-url"
                  type="url"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://api.example.com"
                  required
                />
              </div>
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
              {loading ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
