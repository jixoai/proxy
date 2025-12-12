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
import { CustomHeadersInput } from "@/components/ProxyControl/CustomHeadersInput";
import type { RequestData } from "@/components/ProxyViewerContext";
import { ScrollArea } from "./ui/scroll-area";

interface AddForwardFromRequestDialogProps {
  request: RequestData;
  trigger: React.ReactNode;
  onCreated?: () => void;
}

export function AddForwardFromRequestDialog({
  request,
  trigger,
  onCreated,
}: AddForwardFromRequestDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [method, setMethod] = useState("*");
  const [description, setDescription] = useState("");
  const [customHeaders, setCustomHeaders] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 当对话框打开时，根据请求预填字段
  useEffect(() => {
    if (!open) return;

    try {
      const reqUrl = new URL(request.metadata.request.url);
      const pathFromRequest = reqUrl.pathname || "/";
      const methodFromRequest = request.metadata.request.method || "GET";

      const target =
        request.metadata.targetUrl || request.metadata.originUrl || request.metadata.request.url;
      const targetOrigin = (() => {
        try {
          const u = new URL(target);
          return `${u.protocol}//${u.host}`;
        } catch {
          return target;
        }
      })();

      setName(`${methodFromRequest} ${pathFromRequest}`);
      setPath(pathFromRequest);
      setTargetUrl(targetOrigin);
      setMethod(methodFromRequest);
      setDescription(`基于请求 ${methodFromRequest} ${pathFromRequest} 生成的转发规则`);

      if (request.metadata.forwardedHeaders) {
        setCustomHeaders(JSON.stringify(request.metadata.forwardedHeaders, null, 2));
      } else {
        setCustomHeaders("");
      }

      setError("");
    } catch (e) {
      console.error("Failed to prepare default forward rule from request:", e);
    }
  }, [open, request]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/forwards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instance_id: request.metadata.instanceId,
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
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="p-2 *:p-4 sm:max-w-2xl">
        <form onSubmit={handleSubmit} className="flex h-full flex-col">
          <DialogHeader className="sticky top-0 backdrop-blur-sm">
            <DialogTitle>从请求创建转发规则</DialogTitle>
            <DialogDescription>
              将当前请求保存为转发规则，后续同类请求将自动按该规则转发。
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[65vh] overflow-y-auto p-2!">
            <div className="space-y-4 p-2">
              <div className="space-y-2">
                <Label htmlFor="from-request-name" className="flex items-center gap-2">
                  <Tag className="h-3.5 w-3.5" />
                  规则名称
                </Label>
                <Input
                  id="from-request-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：DeepSeek Chat 完成接口"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="from-request-method">HTTP 方法（可选）</Label>
                <Input
                  id="from-request-method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  placeholder="* 或 GET,POST"
                />
                <p className="text-muted-foreground text-xs">
                  留空或输入 * 表示匹配所有方法；支持使用逗号分隔多个方法，例如 GET,POST。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="from-request-path">路由前缀（可选）</Label>
                <Input
                  id="from-request-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/api 或 /openai"
                />
                <p className="text-muted-foreground text-xs">
                  默认为当前请求的路径。后续所有以该前缀开头的路径将匹配此规则。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="from-request-target-url" className="flex items-center gap-2">
                  <LinkIcon className="h-3.5 w-3.5" />
                  目标 URL
                </Label>
                <Input
                  id="from-request-target-url"
                  type="url"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://api.example.com"
                  required
                />
                <p className="text-muted-foreground text-xs">
                  默认使用当前请求已转发到的目标服务地址（只保留协议和主机部分）。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="from-request-description">规则描述（可选）</Label>
                <Input
                  id="from-request-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="例如：将 /openai 转发到 DeepSeek 的 /api 接口"
                />
              </div>
              <CustomHeadersInput value={customHeaders} onChange={setCustomHeaders} />
              {error && <div className="text-destructive text-sm">{error}</div>}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "创建中..." : "添加到转发规则"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
