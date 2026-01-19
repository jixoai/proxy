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
import type { ProxyConfigFile } from "@/types/proxy";

interface CreateForwardDialogProps {
  instanceName: string;
  trigger?: React.ReactNode;
  /** 创建成功回调，参数为新创建的forward名称 */
  onCreated: (newForwardName?: string) => void;
  /** 预填充数据（用于复制功能） */
  initialData?: {
    name?: string;
    path?: string;
    target?: string;
    methods?: string[];
    description?: string | null;
    headers?: Record<string, string> | null;
    hooks?: string;
  };
}

export function CreateForwardDialog({ instanceName, trigger, onCreated, initialData }: CreateForwardDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [method, setMethod] = useState("*");
  const [description, setDescription] = useState("");
  const [customHeaders, setCustomHeaders] = useState("");
  const [hooks, setHooks] = useState("");
  const [timeoutValue, setTimeoutValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 当dialog打开时，如果有initialData则预填充
  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (newOpen && initialData) {
      setName(initialData.name ? `${initialData.name} (副本)` : "");
      setPath(initialData.path ?? "");
      setTargetUrl(initialData.target ?? "");
      setMethod(initialData.methods?.join(",") ?? "*");
      setDescription(initialData.description ?? "");
      setCustomHeaders(initialData.headers ? JSON.stringify(initialData.headers, null, 2) : "");
      setHooks(initialData.hooks ?? "");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/config");
      const config: ProxyConfigFile = await response.json();
      const instance = config.instances.find((i) => i.name === instanceName);
      
      if (!instance) {
        throw new Error("Instance not found");
      }

      // 解析 headers
      let headers: Record<string, string> | null = null;
      if (customHeaders.trim()) {
        try {
          headers = JSON.parse(customHeaders);
        } catch {
          throw new Error("Invalid headers JSON");
        }
      }

      // 解析 methods
      const methods = method.trim() === "*" || !method.trim() 
        ? ["*"] 
        : method.split(",").map(m => m.trim().toUpperCase()).filter(Boolean);

      // 解析 hooks
      let parsedHooks = null;
      if (hooks.trim()) {
        try {
          parsedHooks = JSON.parse(hooks);
        } catch {
          throw new Error("Invalid hooks JSON");
        }
      }

      // 解析 timeout
      let parsedTimeout: number | null = null;
      if (timeoutValue.trim()) {
        const num = parseInt(timeoutValue.trim(), 10);
        if (isNaN(num) || num <= 0) {
          throw new Error("超时时间必须是正整数");
        }
        parsedTimeout = num;
      }

      instance.forwards.push({
        name,
        enabled: true,
        target: targetUrl,
        description: description || null,
        path: path || null,
        methods,
        headers,
        hooks: parsedHooks,
        timeout: parsedTimeout,
      });

      const saveResponse = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!saveResponse.ok) {
        const data = await saveResponse.json();
        throw new Error(data.error || "Failed to create forward");
      }

      const createdName = name;
      setOpen(false);
      setName("");
      setPath("");
      setTargetUrl("");
      setMethod("*");
      setDescription("");
      setCustomHeaders("");
      setHooks("");
      setTimeoutValue("");
      onCreated(createdName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" variant="outline">
            <Plus className="mr-1 h-3 w-3" />
            添加转发
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="p-2 *:p-4 sm:max-w-2xl">
        <form onSubmit={handleSubmit} className="flex h-full flex-col">
          <DialogHeader>
            <DialogTitle>添加转发规则</DialogTitle>
            <DialogDescription>配置请求转发到目标服务器</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[65vh] p-2!">
            <div className="space-y-4 p-2">
              <div className="space-y-2">
                <Label htmlFor="forward-name" className="flex items-center gap-2">
                  <Tag className="h-3.5 w-3.5" />
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
                <p className="text-muted-foreground text-xs">
                  留空或输入 * 表示匹配所有方法；支持使用逗号分隔多个方法，例如 GET,POST。
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
                <p className="text-muted-foreground text-xs">
                  按路径前缀匹配请求，留空时作为默认规则。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="target-url" className="flex items-center gap-2">
                  <LinkIcon className="h-3.5 w-3.5" />
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
              <CustomHeadersInput value={customHeaders} onChange={setCustomHeaders} />
              <div className="space-y-2">
                <Label htmlFor="forward-timeout">请求超时（可选）</Label>
                <Input
                  id="forward-timeout"
                  type="number"
                  min="1"
                  value={timeoutValue}
                  onChange={(e) => setTimeoutValue(e.target.value)}
                  placeholder="例如：90"
                />
                <p className="text-muted-foreground text-xs">
                  请求超时时间（秒）。留空表示无超时限制。
                </p>
              </div>
              {error && <div className="text-destructive text-sm">{error}</div>}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
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
