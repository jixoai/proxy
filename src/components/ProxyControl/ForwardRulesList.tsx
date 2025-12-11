import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent,
} from "@/components/ui/empty";
import { ArrowRight } from "lucide-react";
import { CreateForwardDialog } from "./CreateForwardDialog";
import { ForwardRuleItem } from "./ForwardRuleItem";
import type { ProxyForward } from "@/types/proxy";
import { useProxyViewer } from "@/components/ProxyViewerContext";

interface ForwardRulesListProps {
  instanceId: number;
  instanceHeaders?: string | null;
  focusedForwardId?: number | null;
}

export function ForwardRulesList({
  instanceId,
  instanceHeaders,
  focusedForwardId,
}: ForwardRulesListProps) {
  const [forwards, setForwards] = useState<ProxyForward[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingOrder, setSavingOrder] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const { clearControlFocus } = useProxyViewer();

  const loadForwards = async () => {
    try {
      const response = await fetch(`/api/instances/${instanceId}/forwards`);
      const data = await response.json();
      setForwards(data);
    } catch (error) {
      console.error("Failed to load forwards:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadForwards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  const handleAutoSort = async () => {
    if (forwards.length === 0) return;

    const sorted = [...forwards].sort((a, b) => {
      const aHasPath = !!(a.path && a.path.length > 0);
      const bHasPath = !!(b.path && b.path.length > 0);

      if (aHasPath && !bHasPath) return -1;
      if (!aHasPath && bHasPath) return 1;

      if (aHasPath && bHasPath) {
        const aLen = a.path!.length;
        const bLen = b.path!.length;
        if (aLen !== bLen) return bLen - aLen;
      }

      return (a.id ?? 0) - (b.id ?? 0);
    });

    setForwards(sorted);
    await saveOrder(sorted);
  };

  const saveOrder = async (currentForwards: ProxyForward[]) => {
    const orderedNames = currentForwards.map((f) => f.name);

    if (orderedNames.length === 0) return;

    setSavingOrder(true);
    try {
      const resp = await fetch(`/api/instances/${instanceId}/forwards/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: orderedNames }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        console.error("Failed to reorder forwards:", data.error);
      } else {
        await loadForwards();
      }
    } catch (error) {
      console.error("Failed to reorder forwards:", error);
    } finally {
      setSavingOrder(false);
    }
  };

  const handleDragStart = (index: number) => {
    setDraggingIndex(index);
  };

  const handleDragOver = (
    event: React.DragEvent<HTMLDivElement>,
    index: number,
  ) => {
    event.preventDefault();
    if (draggingIndex === null || draggingIndex === index) return;

    const fromIndex = draggingIndex;
    setForwards((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return prev;
      next.splice(index, 0, moved);
      return next;
    });
    setDraggingIndex(index);
  };

  const handleDragEnd = async () => {
    if (draggingIndex === null) return;
    setDraggingIndex(null);
    await saveOrder(forwards);
  };

  useEffect(() => {
    if (!focusedForwardId) return;
    const target = itemRefs.current.get(focusedForwardId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusedForwardId]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">转发规则</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">加载中...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle className="text-base">转发规则</CardTitle>
          <div className="flex items-center gap-2">
            {forwards.length > 1 && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleAutoSort}
                disabled={savingOrder}
              >
                自动排序
              </Button>
            )}
            <CreateForwardDialog instanceId={instanceId} onCreated={loadForwards} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {forwards.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ArrowRight />
              </EmptyMedia>
              <EmptyTitle>暂无转发规则</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <CreateForwardDialog
                instanceId={instanceId}
                trigger={
                  <button className="text-sm text-primary hover:underline">
                    添加第一条规则
                  </button>
                }
                onCreated={loadForwards}
              />
            </EmptyContent>
          </Empty>
        ) : (
          <div className="space-y-2">
            {forwards.map((forward, index) => (
              <div
                key={forward.id}
                ref={(el) => {
                  if (forward.id != null && el) {
                    itemRefs.current.set(forward.id, el);
                  }
                }}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragEnd={handleDragEnd}
                onClick={() => {
                  if (
                    typeof focusedForwardId === "number" &&
                    forward.id === focusedForwardId
                  ) {
                    clearControlFocus();
                  }
                }}
                className={`rounded-lg border bg-card transition-opacity ${
                  draggingIndex === index ? "opacity-60" : ""
                }`}
              >
                <ForwardRuleItem
                  forward={forward}
                  onUpdate={loadForwards}
                  highlighted={
                    typeof focusedForwardId === "number" &&
                    typeof forward.id === "number" &&
                    forward.id === focusedForwardId
                  }
                  instanceHeaders={instanceHeaders}
                />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
