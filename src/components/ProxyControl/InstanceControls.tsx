import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Play,
  Square,
  Activity,
  Hash,
  Server as ServerIcon,
  Clock,
  Edit,
  ExternalLink,
  Copy,
  AlertTriangle,
  RotateCw,
  Trash2,
} from "lucide-react";
import type { ProxyInstance } from "@/types/proxy";
import { EditInstanceDialog } from "./EditInstanceDialog";
import { ForwardRulesList } from "./ForwardRulesList";

interface ProxyStatus {
  running: boolean;
  pid?: number;
  port: number;
  listeningPort?: number;
  uptime?: number;
}

interface InstanceControlsProps {
  instance: ProxyInstance;
  onUpdate: () => void;
  focusedForwardId?: number | null;
}

const parseInstanceHeaders = (raw?: string | null) => {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(obj).map(([key, value]) => [key, String(value)]);
  } catch {
    return [];
  }
};

export function InstanceControls({
  instance,
  onUpdate,
  focusedForwardId,
}: InstanceControlsProps) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const globalHeaderEntries = useMemo(
    () => parseInstanceHeaders(instance.instance_headers),
    [instance.instance_headers],
  );

  const fetchStatus = async () => {
    if (!instance.id) return;
    try {
      const response = await fetch(`/api/instances/${instance.id}/status`);
      const data = await response.json();
      setStatus(data);
    } catch (error) {
      console.error("Failed to fetch status:", error);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id]);

  const handleStart = async () => {
    if (!instance.id) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/instances/${instance.id}/start`, {
        method: "POST",
      });
      const data = await response.json();
      if (data.success) {
        setStatus(data.status);
        onUpdate();
      } else {
        alert(`启动失败：${data.error}`);
      }
    } catch (error) {
      console.error("Failed to start instance:", error);
      alert("启动失败");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    if (!instance.id) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/instances/${instance.id}/stop`, {
        method: "POST",
      });
      const data = await response.json();
      if (data.success) {
        setStatus(data.status);
        onUpdate();
      } else {
        alert(`停止失败：${data.error}`);
      }
    } catch (error) {
      console.error("Failed to stop instance:", error);
      alert("停止失败");
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = async () => {
    if (!instance.id) return;
    setLoading(true);
    try {
      const stopResponse = await fetch(`/api/instances/${instance.id}/stop`, {
        method: "POST",
      });
      const stopData = await stopResponse.json();
      if (!stopData.success) {
        alert(`重启失败（停止阶段）：${stopData.error}`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const startResponse = await fetch(`/api/instances/${instance.id}/start`, {
        method: "POST",
      });
      const startData = await startResponse.json();
      if (startData.success) {
        setStatus(startData.status);
        onUpdate();
      } else {
        alert(`重启失败（启动阶段）：${startData.error}`);
      }
    } catch (error) {
      console.error("Failed to restart instance:", error);
      alert("重启失败");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleAutoStart = async () => {
    if (!instance.id) return;
    try {
      await fetch(`/api/instances/${instance.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !instance.enabled }),
      });
      onUpdate();
    } catch (error) {
      console.error("Failed to toggle auto-start:", error);
      alert("更新自动启动状态失败");
    }
  };

  const handleDelete = async () => {
    if (!instance.id) return;
    const confirmed = window.confirm(
      `确定要删除实例 "${instance.name}" 吗？这将同时删除该实例下的所有转发规则。`,
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      const response = await fetch(`/api/instances/${instance.id}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        alert(data.error || "删除实例失败");
        return;
      }
      onUpdate();
    } catch (error) {
      console.error("Failed to delete instance:", error);
      alert("删除实例失败");
    } finally {
      setLoading(false);
    }
  };

  const formatUptime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const portChanged = status?.running && status.listeningPort !== instance.port;
  const currentPort = status?.running ? status.listeningPort : instance.port;
  const proxyUrl = `http://localhost:${currentPort}`;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(proxyUrl);
      alert("代理地址已复制到剪贴板");
    } catch (error) {
      console.error("Failed to copy:", error);
      alert("复制失败");
    }
  };

  return (
    <div className="space-y-5 rounded-2xl border bg-card/40 p-5 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold">{instance.name}</h3>
            <Badge variant="outline" className="font-mono text-xs">
              :{instance.port}
            </Badge>
          </div>
          {instance.description && (
            <p className="text-sm text-muted-foreground">
              {instance.description}
            </p>
          )}
          {globalHeaderEntries.length > 0 && (
            <p className="text-xs text-muted-foreground">
              全局自定义 Header：{globalHeaderEntries.length} 个，所有转发规则都会继承。
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <EditInstanceDialog instance={instance} onUpdated={onUpdate} />
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDelete}
            disabled={loading}
          >
            <Trash2 className="w-4 h-4 text-destructive mr-1" />
            删除
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-xl border bg-background p-4 space-y-3">
          <div className="text-sm font-medium text-muted-foreground">
            访问地址
          </div>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
            <ServerIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <a
              href={proxyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-mono text-primary hover:underline flex items-center gap-1 flex-1 min-w-0"
            >
              {proxyUrl}
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
            </a>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCopyUrl}
              className="flex-shrink-0"
            >
              <Copy className="w-4 h-4" />
            </Button>
          </div>
          {portChanged && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>
                配置端口已修改为{" "}
                <span className="font-mono font-semibold">
                  {instance.port}
                </span>
                ，当前仍监听{" "}
                <span className="font-mono font-semibold">
                  {status?.listeningPort}
                </span>
                ，请重启实例使新端口生效。
              </span>
            </div>
          )}
        </div>

        <div className="rounded-xl border bg-background p-4 space-y-3 text-sm text-muted-foreground">
          <div className="text-sm font-medium text-muted-foreground">
            运行状态
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4" />
              <span>
                状态：
                <Badge
                  variant={status?.running ? "default" : "secondary"}
                  className="ml-1"
                >
                  {status?.running ? "运行中" : "已停止"}
                </Badge>
              </span>
            </div>
            {status?.running && status.pid && (
              <div className="flex items-center gap-2">
                <Hash className="w-4 h-4" />
                <span>PID：{status.pid}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <ServerIcon className="w-4 h-4" />
              <span>当前端口：{currentPort}</span>
            </div>
            {status?.running && status.uptime && (
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span>运行时长：{formatUptime(status.uptime)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {globalHeaderEntries.length > 0 && (
        <div className="rounded-xl border bg-background p-4">
          <div className="text-sm font-medium text-muted-foreground mb-2">
            实例全局 Headers（只读）
          </div>
          <div className="grid gap-1 font-mono text-xs">
            {globalHeaderEntries.map(([key, value]) => (
              <div
                key={key}
                className="flex items-center justify-between gap-2 border-b border-border/60 py-1"
              >
                <span className="text-muted-foreground">{key}</span>
                <span className="text-right break-all">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-background px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-medium leading-none">自动启动</div>
          <p className="text-xs text-muted-foreground mt-1">
            Viewer 启动时自动拉起该内核。仅影响下次启动，不会中断当前实例。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {instance.enabled ? "已开启" : "已关闭"}
          </span>
          <Switch
            checked={instance.enabled}
            onCheckedChange={handleToggleAutoStart}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={handleStart}
          disabled={loading || status?.running === true}
        >
          <Play className="w-4 h-4 mr-1" />
          启动
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRestart}
          disabled={loading || status?.running === false}
        >
          <RotateCw className="w-4 h-4 mr-1" />
          重启
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={handleStop}
          disabled={loading || status?.running === false}
        >
          <Square className="w-4 h-4 mr-1" />
          停止
        </Button>
      </div>

      {typeof instance.id === "number" && (
        <ForwardRulesList
          instanceId={instance.id}
          instanceHeaders={instance.instance_headers ?? null}
          focusedForwardId={focusedForwardId ?? null}
        />
      )}
    </div>
  );
}
