import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, ExternalLink, Edit, GripVertical } from "lucide-react";
import type { ProxyForwardConfig, ProxyConfigFile } from "@/types/proxy";
import { EditForwardDialog } from "./EditForwardDialog";
import { EndpointStatusIndicator } from "@/components/EndpointStatusIndicator";
import type { ForwardEndpointStats } from "@/hooks/useForwardStats";

interface ForwardRuleItemProps {
  forward: ProxyForwardConfig;
  forwardIndex: number;
  instanceName: string;
  onUpdate: () => void;
  highlighted?: boolean;
  instanceHeaders?: Record<string, string> | null;
  unreachable?: boolean;
  showName?: boolean;
  showDragHandle?: boolean;
  dragHandleProps?: Record<string, unknown>;
  stats?: ForwardEndpointStats | null;
}

export function ForwardRuleItem({
  forward,
  forwardIndex,
  instanceName,
  onUpdate,
  highlighted,
  instanceHeaders,
  unreachable = false,
  showName = true,
  showDragHandle = false,
  dragHandleProps,
  stats = null,
}: ForwardRuleItemProps) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm(`确定要删除转发规则 "${forward.name}" 吗？`)) {
      return;
    }

    setDeleting(true);
    try {
      const response = await fetch("/api/config");
      const config: ProxyConfigFile = await response.json();
      const instance = config.instances.find((i) => i.name === instanceName);
      if (instance) {
        instance.forwards.splice(forwardIndex, 1);
        await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });
        onUpdate();
      }
    } catch (error) {
      console.error("Failed to delete forward:", error);
    } finally {
      setDeleting(false);
    }
  };

  const handleToggle = async () => {
    try {
      const response = await fetch("/api/config");
      const config: ProxyConfigFile = await response.json();
      const instance = config.instances.find((i) => i.name === instanceName);
      if (instance && instance.forwards[forwardIndex]) {
        instance.forwards[forwardIndex]!.enabled = !forward.enabled;
        await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });
        onUpdate();
      }
    } catch (error) {
      console.error("Failed to toggle forward:", error);
    }
  };

  const customHeadersCount = forward.headers ? Object.keys(forward.headers).length : 0;

  const methodLabel =
    !forward.methods || forward.methods.length === 0 || forward.methods.includes("*")
      ? "*"
      : forward.methods.join(",");

  const routeLabel =
    forward.path && forward.path.length > 0 ? forward.path : "默认（匹配所有路径）";

  return (
    <div
      className={`bg-card flex items-center justify-between gap-4 rounded-lg border p-3 transition-all ${
        highlighted ? "border-primary/60 bg-primary/5 shadow-sm" : ""
      } ${unreachable ? "opacity-60 grayscale" : ""}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {showDragHandle && (
          <div
            className="text-muted-foreground flex cursor-grab items-center pt-1"
            {...dragHandleProps}
          >
            <GripVertical className="h-4 w-4" />
          </div>
        )}
        <EndpointStatusIndicator stats={stats} size="md" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{forward.name}</span>
            <Badge variant="outline" className="px-1.5 py-0.5 font-mono text-[10px]">
              {methodLabel}
            </Badge>
            <Badge variant={forward.enabled ? "default" : "secondary"} className="text-xs">
              {forward.enabled ? "已启用" : "已禁用"}
            </Badge>
            {unreachable && (
              <Badge variant="outline" className="text-[10px]">
                当前顺序不可命中
              </Badge>
            )}
            {customHeadersCount > 0 && (
              <Badge variant="outline" className="text-xs">
                {customHeadersCount} 个自定义 Header
              </Badge>
            )}
          </div>

          {forward.description && (
            <p className="text-muted-foreground text-xs">{forward.description}</p>
          )}

          <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-1">
              <span>路由前缀</span>
              <span className="bg-muted rounded px-1 py-0.5 font-mono">{routeLabel}</span>
            </div>
            <a
              href={forward.target}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary flex items-center gap-1 hover:underline"
            >
              {forward.target}
              <ExternalLink className="h-3 w-3 flex-shrink-0" />
            </a>
            {unreachable && (
              <span className="text-[11px] text-amber-600">
                同路径已被上方不同名称规则覆盖，拖动调整顺序后生效
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="ml-4 flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={handleToggle}>
          {forward.enabled ? "禁用" : "启用"}
        </Button>
        <EditForwardDialog
          forward={forward}
          forwardIndex={forwardIndex}
          instanceName={instanceName}
          instanceHeaders={instanceHeaders}
          onUpdated={onUpdate}
          trigger={
            <Button size="sm" variant="ghost">
              <Edit className="h-4 w-4" />
            </Button>
          }
        />
        <Button size="sm" variant="ghost" onClick={handleDelete} disabled={deleting}>
          <Trash2 className="text-destructive h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
