import { useState, useEffect, useRef, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyContent } from "@/components/ui/empty";
import { ArrowRight, GripVertical } from "lucide-react";
import { CreateForwardDialog } from "./CreateForwardDialog";
import { ForwardRuleItem } from "./ForwardRuleItem";
import type { ProxyForward, ProxyInstance } from "@/types/proxy";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import { normalizeForwardGroups, normalizePathname } from "@/lib/forward-utils";
import { useForwardStats } from "@/hooks/useForwardStats";

interface ForwardRulesListProps {
  instanceId: number;
  instanceName: string;
  instanceHeaders?: string | null;
  focusedForwardId?: number | null;
}

export function ForwardRulesList({
  instanceId,
  instanceName,
  instanceHeaders,
  focusedForwardId,
}: ForwardRulesListProps) {
  const [forwards, setForwards] = useState<ProxyForward[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingOrder, setSavingOrder] = useState(false);
  const [autoSortEnabled, setAutoSortEnabled] = useState(true);
  const [draggingGroupIndex, setDraggingGroupIndex] = useState<number | null>(null);
  const [draggingItemIndex, setDraggingItemIndex] = useState<{
    groupIndex: number;
    itemIndex: number;
  } | null>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const { clearControlFocus } = useProxyViewer();
  const { getForwardGroupStats } = useForwardStats();

  // 获取自动排序状态
  useEffect(() => {
    fetch("/api/auto-sort/status")
      .then((res) => res.json())
      .then((data) => setAutoSortEnabled(data.enabled))
      .catch(console.error);
  }, []);

  const handleAutoSortToggle = async (enabled: boolean) => {
    setAutoSortEnabled(enabled);
    try {
      await fetch("/api/auto-sort/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    } catch (error) {
      console.error("Failed to toggle auto-sort:", error);
      setAutoSortEnabled(!enabled);
    }
  };

  const buildGroups = (list: ProxyForward[]) => {
    const grouped: Array<{ name: string; items: ProxyForward[] }> = [];
    for (const item of list) {
      const last = grouped.at(-1);
      if (!last || last.name !== item.name) {
        grouped.push({ name: item.name, items: [item] });
      } else {
        last.items.push(item);
      }
    }
    return grouped;
  };

  const loadForwards = async () => {
    try {
      const response = await fetch(`/api/instances/${instanceId}/forwards`);
      const data = await response.json();
      setForwards(normalizeForwardGroups(data));
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
    const sorted = normalizeForwardGroups(forwards);
    setForwards(sorted);
    await saveOrder(sorted);
  };

  const saveOrder = async (currentForwards: ProxyForward[]) => {
    const orderedIds = currentForwards
      .map((f) => f.id)
      .filter((id): id is number => typeof id === "number");

    if (orderedIds.length === 0) return;

    setSavingOrder(true);
    try {
      const resp = await fetch(`/api/instances/${instanceId}/forwards/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: orderedIds }),
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

  const groups = useMemo(() => buildGroups(forwards), [forwards]);

  const handleGroupDragStart = (index: number) => {
    setDraggingGroupIndex(index);
  };

  const handleGroupDragOver = (event: React.DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    if (draggingGroupIndex === null || draggingGroupIndex === index) return;
    setForwards((prev) => {
      const prevGroups = buildGroups(prev);
      const nextGroups = [...prevGroups];
      const [moved] = nextGroups.splice(draggingGroupIndex, 1);
      if (!moved) return prev;
      nextGroups.splice(index, 0, moved);
      return nextGroups.flatMap((g) => g.items);
    });
    setDraggingGroupIndex(index);
  };

  const handleGroupDragEnd = async () => {
    if (draggingGroupIndex === null) return;
    setDraggingGroupIndex(null);
    await saveOrder(forwards);
  };

  // 组内 item 拖动
  const handleItemDragStart = (e: React.DragEvent, groupIndex: number, itemIndex: number) => {
    e.stopPropagation();
    setDraggingItemIndex({ groupIndex, itemIndex });
  };

  const handleItemDragOver = (e: React.DragEvent, groupIndex: number, itemIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggingItemIndex) return;
    if (draggingItemIndex.groupIndex !== groupIndex) return;
    if (draggingItemIndex.itemIndex === itemIndex) return;

    setForwards((prev) => {
      const prevGroups = buildGroups(prev);
      const group = prevGroups[groupIndex];
      if (!group) return prev;

      const newItems = [...group.items];
      const [moved] = newItems.splice(draggingItemIndex.itemIndex, 1);
      if (!moved) return prev;
      newItems.splice(itemIndex, 0, moved);

      const newGroups = [...prevGroups];
      newGroups[groupIndex] = { ...group, items: newItems };
      return newGroups.flatMap((g) => g.items);
    });
    setDraggingItemIndex({ groupIndex, itemIndex });
  };

  const handleItemDragEnd = async () => {
    if (!draggingItemIndex) return;
    setDraggingItemIndex(null);
    await saveOrder(forwards);
  };

  useEffect(() => {
    if (!focusedForwardId) return;
    const target = itemRefs.current.get(focusedForwardId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusedForwardId]);

  const unreachableFlags = useMemo(() => {
    const seen = new Map<string, string>();
    const flags = new Map<number, boolean>();
    forwards.forEach((forward) => {
      if (forward.id == null) return;
      const pathKey = normalizePathname(forward.path ?? "/");
      const ownerName = seen.get(pathKey);
      const unreachable = ownerName !== undefined && ownerName !== forward.name;
      flags.set(forward.id, unreachable);
      if (!ownerName) seen.set(pathKey, forward.name);
    });
    return flags;
  }, [forwards]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">转发规则</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground text-sm">加载中...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">转发规则</CardTitle>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="auto-sort"
                checked={autoSortEnabled}
                onCheckedChange={handleAutoSortToggle}
              />
              <Label htmlFor="auto-sort" className="text-muted-foreground cursor-pointer text-xs">
                智能排序
              </Label>
            </div>
            {forwards.length > 1 && (
              <Button size="sm" variant="outline" onClick={handleAutoSort} disabled={savingOrder}>
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
                  <button className="text-primary text-sm hover:underline">添加第一条规则</button>
                }
                onCreated={loadForwards}
              />
            </EmptyContent>
          </Empty>
        ) : (
          <div className="space-y-3">
            {groups.map((group, groupIndex) => {
              const isMultiItemGroup = group.items.length > 1;
              return (
                <div
                  key={`${group.name}-${groupIndex}`}
                  onDragOver={(e) => {
                    if (draggingGroupIndex !== null) {
                      handleGroupDragOver(e, groupIndex);
                    }
                  }}
                  onDragEnd={handleGroupDragEnd}
                  className={`bg-card/50 rounded-lg border transition-all ${
                    draggingGroupIndex === groupIndex ? "opacity-60" : ""
                  }`}
                >
                  <div
                    draggable
                    onDragStart={() => handleGroupDragStart(groupIndex)}
                    className="bg-muted/40 flex cursor-grab items-center gap-2 border-b px-3 py-2"
                  >
                    <GripVertical className="text-muted-foreground h-4 w-4" />
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>{group.name}</span>
                      {isMultiItemGroup && (
                        <span className="text-muted-foreground text-xs">
                          同名规则为一组，失败自动在组内切换
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2 p-2">
                    {group.items.map((forward, itemIndex) => (
                      <div
                        key={forward.id}
                        ref={(el) => {
                          if (forward.id != null && el) {
                            itemRefs.current.set(forward.id, el);
                          }
                        }}
                        draggable={isMultiItemGroup}
                        onDragStart={(e) =>
                          isMultiItemGroup && handleItemDragStart(e, groupIndex, itemIndex)
                        }
                        onDragOver={(e) =>
                          isMultiItemGroup && handleItemDragOver(e, groupIndex, itemIndex)
                        }
                        onDragEnd={handleItemDragEnd}
                        onClick={() => {
                          if (
                            typeof focusedForwardId === "number" &&
                            forward.id === focusedForwardId
                          ) {
                            clearControlFocus();
                          }
                        }}
                        className={
                          draggingItemIndex?.groupIndex === groupIndex &&
                          draggingItemIndex?.itemIndex === itemIndex
                            ? "opacity-60"
                            : ""
                        }
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
                          unreachable={
                            forward.id != null ? (unreachableFlags.get(forward.id) ?? false) : false
                          }
                          showName={false}
                          showDragHandle={isMultiItemGroup}
                          stats={
                            getForwardGroupStats(instanceName, forward.name)[itemIndex] ?? null
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
