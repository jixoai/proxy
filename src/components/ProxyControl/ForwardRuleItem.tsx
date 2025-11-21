import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, ExternalLink, Edit, GripVertical } from "lucide-react";
import type { ProxyForward } from "@/types/proxy";
import { EditForwardDialog } from "./EditForwardDialog";

interface ForwardRuleItemProps {
  forward: ProxyForward;
  onUpdate: () => void;
  highlighted?: boolean;
  instanceHeaders?: string | null;
}

export function ForwardRuleItem({
  forward,
  onUpdate,
  highlighted,
  instanceHeaders,
}: ForwardRuleItemProps) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm(`确定要删除转发规则 "${forward.name}" 吗？`)) {
      return;
    }

    setDeleting(true);
    try {
      await fetch(`/api/forwards/${forward.id}`, { method: "DELETE" });
      onUpdate();
    } catch (error) {
      console.error("Failed to delete forward:", error);
    } finally {
      setDeleting(false);
    }
  };

  const handleToggle = async () => {
    try {
      await fetch(`/api/forwards/${forward.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !forward.enabled }),
      });
      onUpdate();
    } catch (error) {
      console.error("Failed to toggle forward:", error);
    }
  };

  const customHeadersCount = forward.custom_headers
    ? Object.keys(JSON.parse(forward.custom_headers)).length
    : 0;

  const methodLabel =
    !forward.method || forward.method.trim() === "" || forward.method === "*"
      ? "*"
      : forward.method;

  const routeLabel =
    forward.path && forward.path.length > 0
      ? forward.path
      : "默认（匹配所有路径）";

  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-lg border bg-card p-3 transition-all ${
        highlighted ? "border-primary/60 bg-primary/5 shadow-sm" : ""
      }`}
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className="flex items-center pt-1 text-muted-foreground cursor-grab">
          <GripVertical className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{forward.name}</span>
            <Badge
              variant="outline"
              className="text-[10px] font-mono px-1.5 py-0.5"
            >
              {methodLabel}
            </Badge>
            <Badge
              variant={forward.enabled ? "default" : "secondary"}
              className="text-xs"
            >
              {forward.enabled ? "启用" : "禁用"}
            </Badge>
            {customHeadersCount > 0 && (
              <Badge variant="outline" className="text-xs">
                {customHeadersCount} 个自定义 Header
              </Badge>
            )}
          </div>

          {forward.description && (
            <p className="text-xs text-muted-foreground">{forward.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <span>路由前缀</span>
              <span className="font-mono px-1 py-0.5 rounded bg-muted">
                {routeLabel}
              </span>
            </div>
            <a
              href={forward.target_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-primary hover:underline"
            >
              {forward.target_url}
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
            </a>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 ml-4">
        <Button size="sm" variant="ghost" onClick={handleToggle}>
          {forward.enabled ? "禁用" : "启用"}
        </Button>
        <EditForwardDialog
          forward={forward}
          instanceHeaders={instanceHeaders}
          onUpdated={onUpdate}
          trigger={
            <Button size="sm" variant="ghost">
              <Edit className="w-4 h-4" />
            </Button>
          }
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDelete}
          disabled={deleting}
        >
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      </div>
    </div>
  );
}
