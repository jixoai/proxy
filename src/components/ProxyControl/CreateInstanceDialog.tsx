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
import { Textarea } from "@/components/ui/textarea";
import { Plus, Tag, Network } from "lucide-react";
import { CustomHeadersInput } from "./CustomHeadersInput";

interface CreateInstanceDialogProps {
  trigger?: React.ReactNode;
  onCreated: () => void;
}

export function CreateInstanceDialog({ trigger, onCreated }: CreateInstanceDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [description, setDescription] = useState("");
  const [instanceHeaders, setInstanceHeaders] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          port: parseInt(port),
          enabled: true,
          description: description || null,
          instance_headers: instanceHeaders || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to create instance");
      }

      setOpen(false);
      setName("");
      setPort("");
      setDescription("");
      setInstanceHeaders("");
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
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            创建实例
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建代理实例</DialogTitle>
          <DialogDescription>配置一个新的代理服务器实例</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="flex items-center gap-2">
                <Tag className="h-3.5 w-3.5" />
                实例名称
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：开发环境"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">实例描述（可选）</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例如：转发到内部 OpenAI 兼容接口，用于日常开发调试"
              />
            </div>
            <CustomHeadersInput value={instanceHeaders} onChange={setInstanceHeaders} />
            <div className="space-y-2">
              <Label htmlFor="port" className="flex items-center gap-2">
                <Network className="h-3.5 w-3.5" />
                端口号
              </Label>
              <Input
                id="port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="例如：28000"
                min="1024"
                max="65535"
                required
              />
            </div>
            {error && <div className="text-destructive text-sm">{error}</div>}
          </div>
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
