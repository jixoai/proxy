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
import { Textarea } from "@/components/ui/textarea";
import { Tag, Network, Edit } from "lucide-react";
import type { ProxyInstanceConfig, ProxyConfigFile, HooksConfig } from "@/types/proxy";
import { CustomHeadersInput } from "./CustomHeadersInput";
import { HooksInput } from "./HooksInput";

interface EditInstanceDialogProps {
  instance: ProxyInstanceConfig;
  trigger?: React.ReactNode;
  onUpdated: () => void;
}

export function EditInstanceDialog({ instance, trigger, onUpdated }: EditInstanceDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(instance.name);
  const [port, setPort] = useState(instance.port.toString());
  const [description, setDescription] = useState(instance.description || "");
  const [instanceHeaders, setInstanceHeaders] = useState(
    instance.headers ? JSON.stringify(instance.headers) : ""
  );
  const [hooks, setHooks] = useState(instance.hooks ? JSON.stringify(instance.hooks) : "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName(instance.name);
      setPort(instance.port.toString());
      setDescription(instance.description || "");
      setInstanceHeaders(instance.headers ? JSON.stringify(instance.headers) : "");
      setHooks(instance.hooks ? JSON.stringify(instance.hooks) : "");
      setError("");
    }
  }, [open, instance]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/config");
      const config: ProxyConfigFile = await response.json();
      const idx = config.instances.findIndex((i) => i.name === instance.name);
      
      if (idx < 0) {
        throw new Error("Instance not found");
      }

      // 解析 headers
      let headers: Record<string, string> | null = null;
      if (instanceHeaders.trim()) {
        try {
          headers = JSON.parse(instanceHeaders);
        } catch {
          throw new Error("Invalid headers JSON");
        }
      }

      // 解析 hooks
      let parsedHooks: HooksConfig | null = null;
      if (hooks.trim()) {
        try {
          parsedHooks = JSON.parse(hooks);
        } catch {
          throw new Error("Invalid hooks JSON");
        }
      }

      config.instances[idx] = {
        ...config.instances[idx]!,
        name,
        port: parseInt(port),
        description: description || null,
        headers,
        hooks: parsedHooks,
      };

      const saveResponse = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!saveResponse.ok) {
        const data = await saveResponse.json();
        throw new Error(data.error || "Failed to update instance");
      }

      setOpen(false);
      onUpdated();
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
          <Button size="sm" variant="ghost">
            <Edit className="mr-1 h-4 w-4" />
            编辑
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑代理实例</DialogTitle>
          <DialogDescription>修改代理服务器实例的配置</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name" className="flex items-center gap-2">
                <Tag className="h-3.5 w-3.5" />
                实例名称
              </Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：开发环境"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-port" className="flex items-center gap-2">
                <Network className="h-3.5 w-3.5" />
                端口号
              </Label>
              <Input
                id="edit-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="例如：8000"
                min="1024"
                max="65535"
                required
              />
              <p className="text-muted-foreground text-xs">修改端口后需要重启实例才能生效。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">实例描述（可选）</Label>
              <Textarea
                id="edit-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例如：转发到内部 OpenAI 兼容接口，用于日常开发调试"
              />
            </div>
            <CustomHeadersInput value={instanceHeaders} onChange={setInstanceHeaders} />
            <HooksInput value={hooks} onChange={setHooks} />
            {error && <div className="text-destructive text-sm">{error}</div>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
