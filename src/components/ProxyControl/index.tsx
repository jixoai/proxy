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
import { Server, Database, Pencil, FolderOpen, Info } from "lucide-react";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { InstanceList } from "./InstanceList";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function ProxyControl() {
  const {
    instances,
    instancesLoading,
    reloadInstances,
    controlFocusInstanceName,
    controlFocusForwardName,
    frontendAutoPullConfig,
    setFrontendAutoPullConfig,
  } = useProxyViewer();

  const [reloadLoading, setReloadLoading] = useState(false);
  const [autoPullLoading, setAutoPullLoading] = useState(false);
  const [lastReloadMessage, setLastReloadMessage] = useState<string | null>(null);

  // dbPath 相关状态
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [currentDataDir, setCurrentDataDir] = useState<string | null>(null);
  const [dbPathLoading, setDbPathLoading] = useState(true);
  const [editDbPathDialogOpen, setEditDbPathDialogOpen] = useState(false);
  const [editDbPathValue, setEditDbPathValue] = useState("");
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [saveDbPathLoading, setSaveDbPathLoading] = useState(false);

  // 加载 dbPath
  useEffect(() => {
    const fetchDbPath = async () => {
      try {
        const response = await fetch("/api/settings/db-path");
        const data = await response.json();
        setDbPath(data.dbPath);
        setResolvedPath(data.resolvedPath);
        setCurrentDataDir(data.currentDataDir);
      } catch (error) {
        console.error("Failed to fetch dbPath:", error);
      } finally {
        setDbPathLoading(false);
      }
    };
    fetchDbPath();
  }, []);

  const handleEditDbPath = () => {
    setEditDbPathValue(dbPath || "");
    setEditDbPathDialogOpen(true);
  };

  const handleSaveDbPath = () => {
    if (editDbPathValue.trim() === dbPath) {
      setEditDbPathDialogOpen(false);
      return;
    }
    setEditDbPathDialogOpen(false);
    setConfirmDialogOpen(true);
  };

  const handleConfirmSaveDbPath = async () => {
    setSaveDbPathLoading(true);
    try {
      const response = await fetch("/api/settings/db-path", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbPath: editDbPathValue.trim() }),
      });
      const data = await response.json();
      if (data.success) {
        setDbPath(editDbPathValue.trim());
      } else {
        alert(`保存失败: ${data.error}`);
      }
    } catch (error) {
      console.error("Failed to save dbPath:", error);
      alert("保存失败");
    } finally {
      setSaveDbPathLoading(false);
      setConfirmDialogOpen(false);
    }
  };

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

  const handleAutoPullToggle = async (next: boolean) => {
    setAutoPullLoading(true);
    try {
      await setFrontendAutoPullConfig(next);
    } finally {
      setAutoPullLoading(false);
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
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Switch
                    checked={frontendAutoPullConfig}
                    disabled={autoPullLoading}
                    onCheckedChange={handleAutoPullToggle}
                  />
                  <span>前端自动拉取配置</span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="max-w-xs text-xs">
                  开启后，收到配置变更通知（config-changed）时自动重新拉取 /api/config 刷新界面。
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {instances.length > 0 && <CreateInstanceDialog onCreated={reloadInstances} />}
        </div>
      </div>
      {lastReloadMessage && (
        <div className="text-muted-foreground text-xs">{lastReloadMessage}</div>
      )}

      {/* 数据目录卡片 */}
      <div className="bg-card/40 rounded-xl border p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 rounded-lg p-2">
              <Database className="h-5 w-5 text-primary" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium">数据目录</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <div className="space-y-1 text-xs">
                        <div className="font-medium">支持的模板变量:</div>
                        <div><code className="bg-white/20 px-1 rounded">~</code> - 用户主目录</div>
                        <div><code className="bg-white/20 px-1 rounded">{"${VERSION}"}</code> - 当前版本号</div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {dbPathLoading ? (
                <div className="text-muted-foreground text-xs">加载中...</div>
              ) : (
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs">模板:</span>
                    <code className="bg-muted/50 rounded px-1 py-0.5 font-mono text-xs">
                      {dbPath || "未设置"}
                    </code>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs">实际:</span>
                    <code className="bg-muted/50 rounded px-1 py-0.5 font-mono text-xs text-muted-foreground">
                      {resolvedPath || currentDataDir || "-"}
                    </code>
                  </div>
                </div>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleEditDbPath}
            disabled={dbPathLoading}
          >
            <Pencil className="mr-1 h-4 w-4" />
            修改
          </Button>
        </div>
      </div>

      {/* 编辑 dbPath 对话框 */}
      <Dialog open={editDbPathDialogOpen} onOpenChange={setEditDbPathDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5" />
              修改数据目录
            </DialogTitle>
            <DialogDescription>
              设置数据存储目录路径，用于存放数据库文件和临时配置。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">数据目录路径</label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <div className="space-y-1 text-xs">
                        <div className="font-medium">支持的模板变量:</div>
                        <div><code className="bg-white/20 px-1 rounded">~</code> - 用户主目录</div>
                        <div><code className="bg-white/20 px-1 rounded">{"${VERSION}"}</code> - 当前版本号</div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Input
                value={editDbPathValue}
                onChange={(e) => setEditDbPathValue(e.target.value)}
                placeholder="~/.jixo/.proxy/${VERSION}"
              />
            </div>
            {resolvedPath && resolvedPath !== editDbPathValue && (
              <div className="bg-muted/50 rounded-lg p-3 text-xs space-y-1">
                <div className="text-muted-foreground">当前使用路径:</div>
                <code className="text-foreground break-all">{resolvedPath}</code>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDbPathDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSaveDbPath}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 确认对话框 */}
      <AlertDialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认修改数据目录</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                修改数据目录 <strong>需要重启程序</strong> 才能生效。
              </span>
              <span className="block text-muted-foreground">
                新路径: <code className="bg-muted rounded px-1 py-0.5">{editDbPathValue}</code>
              </span>
              <span className="block text-amber-600 dark:text-amber-400">
                注意: 重启前的数据不会自动迁移到新目录。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saveDbPathLoading}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSaveDbPath} disabled={saveDbPathLoading}>
              {saveDbPathLoading ? "保存中..." : "确认修改"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
          focusedInstanceName={controlFocusInstanceName}
          focusedForwardName={controlFocusForwardName}
        />
      )}
    </div>
  );
}
