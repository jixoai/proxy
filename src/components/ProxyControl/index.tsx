import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { Server } from "lucide-react";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { InstanceList } from "./InstanceList";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import { Switch } from "@/components/ui/switch";

export function ProxyControl() {
  const {
    instances,
    instancesLoading,
    reloadInstances,
    controlFocusInstanceId,
    controlFocusForwardId,
  } = useProxyViewer();

  const [reloadLoading, setReloadLoading] = useState(false);
  const [watching, setWatching] = useState(true); // 默认开启
  const [watchLoading, setWatchLoading] = useState(false);
  const [lastReloadMessage, setLastReloadMessage] = useState<string | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch("/api/reload/status");
        const data = await response.json();
        setWatching(Boolean(data.watching));
      } catch (error) {
        console.error("Failed to load reload status:", error);
      }
    };
    fetchStatus();
  }, []);

  const handleReload = async () => {
    setReloadLoading(true);
    setLastReloadMessage(null);
    try {
      const response = await fetch("/api/reload", { method: "POST" });
      const data = await response.json();
      if (response.ok) {
        const successCount = Array.isArray(data.reloaded) ? data.reloaded.length : 0;
        const failCount = Array.isArray(data.failed) ? data.failed.length : 0;
        setLastReloadMessage(
          failCount > 0
            ? `重载完成：成功 ${successCount} 个，失败 ${failCount} 个`
            : `已重载 ${successCount} 个实例`,
        );
        // 刷新实例列表以反映配置文件的变更
        await reloadInstances();
      } else {
        setLastReloadMessage(data.error || "重载失败");
      }
    } catch (error) {
      setLastReloadMessage(error instanceof Error ? error.message : "重载失败");
    } finally {
      setReloadLoading(false);
    }
  };

  const handleWatchToggle = async (next: boolean) => {
    setWatchLoading(true);
    try {
      const response = await fetch("/api/reload/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await response.json();
      setWatching(Boolean(data.watching));
    } catch (error) {
      console.error("Failed to update watch state:", error);
    } finally {
      setWatchLoading(false);
    }
  };

  if (instancesLoading && instances.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="text-2xl font-bold">代理实例管理</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleReload} disabled={reloadLoading}>
            {reloadLoading ? "重载中..." : "重载配置"}
          </Button>
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Switch
              checked={watching}
              disabled={watchLoading}
              onCheckedChange={handleWatchToggle}
            />
            <span>自动监听配置文件</span>
          </div>
          {instances.length > 0 && <CreateInstanceDialog onCreated={reloadInstances} />}
        </div>
      </div>
      {lastReloadMessage && (
        <div className="text-muted-foreground text-xs">{lastReloadMessage}</div>
      )}

      {instances.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Server />
            </EmptyMedia>
            <EmptyTitle>暂无代理实例</EmptyTitle>
            <EmptyDescription>创建第一个代理实例开始使用 Proxy Viewer</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <CreateInstanceDialog trigger={<Button>创建实例</Button>} onCreated={reloadInstances} />
          </EmptyContent>
        </Empty>
      ) : (
        <InstanceList
          instances={instances}
          onUpdate={reloadInstances}
          focusedInstanceId={controlFocusInstanceId}
          focusedForwardId={controlFocusForwardId}
        />
      )}
    </div>
  );
}
