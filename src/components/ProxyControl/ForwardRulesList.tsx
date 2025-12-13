import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
  DragOverlay,
  type UniqueIdentifier,
  defaultDropAnimationSideEffects,
  type DropAnimation,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyContent } from "@/components/ui/empty";
import { ArrowRight, GripVertical } from "lucide-react";
import { CreateForwardDialog } from "./CreateForwardDialog";
import { ForwardRuleItem } from "./ForwardRuleItem";
import type { ProxyForward, ProxyConfigFile, ProxyForwardConfig } from "@/types/proxy";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import { normalizeForwardGroups, normalizePathname } from "@/lib/forward-utils";

// 将 ProxyForwardConfig 转换为 ProxyForward (前端显示用)
function configToForward(config: ProxyForwardConfig, index: number): ProxyForward {
  return {
    id: index, // 使用数组索引作为 ID
    name: config.name,
    enabled: config.enabled,
    target_url: config.target,
    description: config.description,
    path: config.path,
    method: config.methods?.join(",") ?? "*",
    custom_headers: config.headers ? JSON.stringify(config.headers) : null,
  };
}
import { useForwardStats } from "@/hooks/useForwardStats";

interface ForwardRulesListProps {
  instanceId: number;
  instanceName: string;
  instanceHeaders?: string | null;
  focusedForwardId?: number | null;
}

interface ForwardGroup {
  id: string;
  name: string;
  items: ProxyForward[];
}

// Drop 动画配置
const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: "0.5",
      },
    },
  }),
};

// 组容器组件 - 不再使用 useSortable，改为手动拖拽
function DraggableGroup({
  group,
  isMultiItemGroup,
  children,
  isDragging,
  onDragStart,
}: {
  group: ForwardGroup;
  isMultiItemGroup: boolean;
  children?: React.ReactNode;
  isDragging: boolean;
  onDragStart: (groupId: string) => void;
}) {
  return (
    <div
      className={`bg-card/50 rounded-lg border transition-shadow ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          onDragStart(group.id);
        }}
        className="bg-muted/40 flex cursor-grab items-center gap-2 rounded-t-lg border-b px-3 py-2 active:cursor-grabbing"
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
      {children}
    </div>
  );
}

// 组间插入线指示器
function GroupDropIndicator() {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="h-0.5 flex-1 rounded bg-primary" />
      <div className="h-2 w-2 rounded-full bg-primary" />
      <div className="h-0.5 flex-1 rounded bg-primary" />
    </div>
  );
}

// 可排序的组内 item 组件
function SortableItem({
  id,
  forward,
  onUpdate,
  highlighted,
  instanceHeaders,
  unreachable,
  showDragHandle,
  stats,
  focusedForwardId,
  clearControlFocus,
  itemRefs,
  isDragOverlay = false,
}: {
  id: string;
  forward: ProxyForward;
  onUpdate: () => void;
  highlighted: boolean;
  instanceHeaders: string | null;
  unreachable: boolean;
  showDragHandle: boolean;
  stats: any;
  focusedForwardId: number | null;
  clearControlFocus: () => void;
  itemRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
  isDragOverlay?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: !showDragHandle,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        if (forward.id != null && el) {
          itemRefs.current.set(forward.id, el);
        }
      }}
      style={style}
      onClick={() => {
        if (typeof focusedForwardId === "number" && forward.id === focusedForwardId) {
          clearControlFocus();
        }
      }}
      className={`transition-opacity ${isDragging && !isDragOverlay ? "opacity-40" : ""} ${
        isDragOverlay ? "shadow-xl ring-2 ring-primary/50 rounded-lg" : ""
      }`}
    >
      <ForwardRuleItem
        forward={forward}
        onUpdate={onUpdate}
        highlighted={highlighted}
        instanceHeaders={instanceHeaders}
        unreachable={unreachable}
        showName={false}
        showDragHandle={showDragHandle}
        dragHandleProps={showDragHandle ? { ...attributes, ...listeners } : undefined}
        stats={stats}
      />
    </div>
  );
}

// Item 的 Overlay 预览
function ItemOverlay({
  forward,
  instanceHeaders,
  stats,
}: {
  forward: ProxyForward;
  instanceHeaders: string | null;
  stats: any;
}) {
  return (
    <div className="shadow-xl ring-2 ring-primary/50 rounded-lg">
      <ForwardRuleItem
        forward={forward}
        onUpdate={() => {}}
        highlighted={false}
        instanceHeaders={instanceHeaders}
        unreachable={false}
        showName={false}
        showDragHandle={true}
        stats={stats}
      />
    </div>
  );
}

export function ForwardRulesList({
  instanceId,
  instanceName,
  instanceHeaders,
  focusedForwardId,
}: ForwardRulesListProps) {
  const [forwards, setForwards] = useState<ProxyForward[]>([]);
  const [configData, setConfigData] = useState<ProxyConfigFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingOrder, setSavingOrder] = useState(false);
  const [autoSortEnabled, setAutoSortEnabled] = useState(false);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  // 组拖动状态 (使用原生 HTML5 拖拽)
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [groupDropIndex, setGroupDropIndex] = useState<number | null>(null);
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const { clearControlFocus, configVersion } = useProxyViewer();
  const { getForwardGroupStats } = useForwardStats();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleAutoSortToggle = async (enabled: boolean) => {
    if (!configData) return;
    
    setAutoSortEnabled(enabled);
    try {
      const newConfig = { ...configData };
      const instanceIndex = newConfig.instances.findIndex((i) => i.name === instanceName);
      if (instanceIndex === -1) return;

      const instance = newConfig.instances[instanceIndex]!;
      newConfig.instances[instanceIndex] = {
        ...instance,
        settings: {
          ...instance.settings,
          autoSort: enabled,
        },
      };

      const resp = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });
      if (resp.ok) {
        setConfigData(newConfig);
      } else {
        setAutoSortEnabled(!enabled);
      }
    } catch (error) {
      console.error("Failed to toggle auto-sort:", error);
      setAutoSortEnabled(!enabled);
    }
  };

  const buildGroups = (list: ProxyForward[]): ForwardGroup[] => {
    const grouped: ForwardGroup[] = [];
    for (const item of list) {
      const last = grouped.at(-1);
      if (!last || last.name !== item.name) {
        // 使用 name 作为稳定的 id
        grouped.push({ id: `group-${item.name}`, name: item.name, items: [item] });
      } else {
        last.items.push(item);
      }
    }
    return grouped;
  };

  const loadForwards = async () => {
    try {
      const response = await fetch("/api/config");
      const config: ProxyConfigFile = await response.json();
      setConfigData(config);
      
      const instance = config.instances.find((i) => i.name === instanceName);
      if (instance) {
        // 转换为前端格式，使用数组索引作为 ID
        const forwardsList = instance.forwards.map((f, idx) => configToForward(f, idx));
        // normalize 只聚合同名规则，不改变顺序
        const normalized = normalizeForwardGroups(forwardsList);
        setForwards(normalized);
        // 读取 autoSort 状态
        setAutoSortEnabled(instance.settings?.autoSort ?? false);
      } else {
        setForwards([]);
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadForwards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, configVersion]);

  const handleAutoSort = async () => {
    if (forwards.length === 0) return;
    const sorted = normalizeForwardGroups(forwards);
    setForwards(sorted);
    await saveOrder(sorted);
  };

  const saveOrder = async (currentForwards: ProxyForward[]) => {
    if (!configData) return;

    setSavingOrder(true);
    try {
      // 找到当前实例并更新其 forwards
      const newConfig = { ...configData };
      const instanceIndex = newConfig.instances.findIndex((i) => i.name === instanceName);
      if (instanceIndex === -1) {
        console.error("Instance not found:", instanceName);
        return;
      }

      const instance = newConfig.instances[instanceIndex]!;
      const oldForwards = instance.forwards;

      // 根据新顺序重建 forwards 数组
      // currentForwards 的 id 是原始数组的索引
      const newForwards: ProxyForwardConfig[] = currentForwards.map((f) => {
        const originalIndex = f.id;
        if (originalIndex !== undefined && oldForwards[originalIndex]) {
          return oldForwards[originalIndex]!;
        }
        // fallback: 通过 name + description 匹配
        return oldForwards.find(
          (of) => of.name === f.name && of.description === f.description
        ) ?? oldForwards[0]!;
      });

      newConfig.instances[instanceIndex] = {
        ...instance,
        forwards: newForwards,
      };

      const resp = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        console.error("Failed to save config:", data.error);
        await loadForwards();
      } else {
        // 更新本地 configData
        setConfigData(newConfig);
      }
    } catch (error) {
      console.error("Failed to save config:", error);
      await loadForwards();
    } finally {
      setSavingOrder(false);
    }
  };

  const groups = useMemo(() => buildGroups(forwards), [forwards]);

  // 组拖动处理函数
  const handleGroupDragStart = useCallback((groupId: string) => {
    setDraggingGroupId(groupId);
    setGroupDropIndex(null);
  }, []);

  const handleGroupDragOver = useCallback((e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (!draggingGroupId) return;
    
    const draggingIndex = groups.findIndex((g) => g.id === draggingGroupId);
    if (draggingIndex === -1) return;
    
    // 计算鼠标在目标元素的位置（上半部分还是下半部分）
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertBefore = e.clientY < midY;
    
    let dropIndex: number;
    if (insertBefore) {
      dropIndex = targetIndex;
    } else {
      dropIndex = targetIndex + 1;
    }
    
    // 不在自己的位置或相邻位置显示指示器
    if (dropIndex === draggingIndex || dropIndex === draggingIndex + 1) {
      setGroupDropIndex(null);
    } else {
      setGroupDropIndex(dropIndex);
    }
  }, [draggingGroupId, groups]);

  const handleGroupDragEnd = useCallback((e?: React.DragEvent) => {
    // 阻止事件冒泡，避免重复触发
    e?.stopPropagation();
    
    // 防止重复执行
    if (!draggingGroupId) return;
    
    const currentDraggingId = draggingGroupId;
    const currentDropIndex = groupDropIndex;
    
    // 立即清除状态，防止重复触发
    setDraggingGroupId(null);
    setGroupDropIndex(null);
    
    if (currentDropIndex === null) return;
    
    const oldIndex = groups.findIndex((g) => g.id === currentDraggingId);
    if (oldIndex === -1) return;
    
    // 调整 dropIndex：如果 dropIndex > oldIndex，需要 -1
    let newIndex = currentDropIndex;
    if (newIndex > oldIndex) {
      newIndex -= 1;
    }
    
    if (oldIndex !== newIndex) {
      const newGroups = arrayMove(groups, oldIndex, newIndex);
      const newForwards = newGroups.flatMap((g) => g.items);
      setForwards(newForwards);
      saveOrder(newForwards);
    }
  }, [draggingGroupId, groupDropIndex, groups, saveOrder]);

  const handleGroupDragLeave = useCallback(() => {
    // 延迟清除，避免在元素间移动时闪烁
  }, []);

  const activeItem = useMemo(() => {
    if (!activeId) return null;
    const id = String(activeId);
    if (id.startsWith("item-")) {
      const forwardId = Number(id.replace("item-", ""));
      for (const group of groups) {
        const found = group.items.find((f) => f.id === forwardId);
        if (found) return found;
      }
    }
    return null;
  }, [activeId, groups]);

  const activeItemGroupIndex = useMemo(() => {
    if (!activeId) return null;
    const id = String(activeId);
    if (id.startsWith("item-")) {
      const forwardId = Number(id.replace("item-", ""));
      for (let i = 0; i < groups.length; i++) {
        if (groups[i]!.items.some((f) => f.id === forwardId)) {
          return i;
        }
      }
    }
    return null;
  }, [activeId, groups]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
  };

  const handleDragCancel = () => {
    setActiveId(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    
    setActiveId(null);

    if (!over) return;

    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);

    if (activeIdStr === overIdStr) return;

    // 组内 item 拖动 (组间拖动由原生 HTML5 拖拽处理)
    if (activeIdStr.startsWith("item-") && overIdStr.startsWith("item-")) {
      const activeForwardId = Number(activeIdStr.replace("item-", ""));
      const overForwardId = Number(overIdStr.replace("item-", ""));

      let activeGroupIdx = -1;
      let activeItemIdx = -1;
      let overGroupIdx = -1;
      let overItemIdx = -1;

      groups.forEach((group, gIdx) => {
        group.items.forEach((item, iIdx) => {
          if (item.id === activeForwardId) {
            activeGroupIdx = gIdx;
            activeItemIdx = iIdx;
          }
          if (item.id === overForwardId) {
            overGroupIdx = gIdx;
            overItemIdx = iIdx;
          }
        });
      });

      // 只允许同组内拖动
      if (activeGroupIdx === overGroupIdx && activeGroupIdx !== -1) {
        const group = groups[activeGroupIdx];
        if (group && activeItemIdx !== overItemIdx) {
          const newItems = arrayMove(group.items, activeItemIdx, overItemIdx);
          const newGroups = [...groups];
          newGroups[activeGroupIdx] = { ...group, items: newItems };
          const newForwards = newGroups.flatMap((g) => g.items);
          setForwards(newForwards);
          saveOrder(newForwards);
        }
      }
    }
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
                组内自动排序
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div
              className="flex flex-col gap-3"
              onDragOver={(e) => {
                // 允许拖放到容器末尾
                if (draggingGroupId && e.target === e.currentTarget) {
                  e.preventDefault();
                  setGroupDropIndex(groups.length);
                }
              }}
              onDrop={handleGroupDragEnd}
            >
              {groups.map((group, groupIndex) => {
                const isMultiItemGroup = group.items.length > 1;
                const itemIds = group.items.map((f) => `item-${f.id}`);
                const isDraggingThisGroup = draggingGroupId === group.id;

                return (
                  <div key={group.id}>
                    {/* 在此组之前显示插入线 */}
                    {groupDropIndex === groupIndex && <GroupDropIndicator />}
                    
                    <div
                      ref={(el) => {
                        if (el) groupRefs.current.set(group.id, el);
                      }}
                      onDragOver={(e) => handleGroupDragOver(e, groupIndex)}
                      onDrop={handleGroupDragEnd}
                    >
                      <DraggableGroup
                        group={group}
                        isMultiItemGroup={isMultiItemGroup}
                        isDragging={isDraggingThisGroup}
                        onDragStart={handleGroupDragStart}
                      >
                        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
                          <div className="flex flex-col gap-2 p-2">
                            {group.items.map((forward, itemIndex) => (
                              <SortableItem
                                key={forward.id ?? `fallback-${groupIndex}-${itemIndex}`}
                                id={`item-${forward.id}`}
                                forward={forward}
                                onUpdate={loadForwards}
                                highlighted={
                                  typeof focusedForwardId === "number" &&
                                  typeof forward.id === "number" &&
                                  forward.id === focusedForwardId
                                }
                                instanceHeaders={instanceHeaders ?? null}
                                unreachable={
                                  forward.id != null
                                    ? (unreachableFlags.get(forward.id) ?? false)
                                    : false
                                }
                                showDragHandle={isMultiItemGroup}
                                stats={
                                  getForwardGroupStats(instanceName, forward.name)[itemIndex] ?? null
                                }
                                focusedForwardId={focusedForwardId ?? null}
                                clearControlFocus={clearControlFocus}
                                itemRefs={itemRefs}
                              />
                            ))}
                          </div>
                        </SortableContext>
                      </DraggableGroup>
                    </div>
                  </div>
                );
              })}
              {/* 在最后一个组之后显示插入线 */}
              {groupDropIndex === groups.length && <GroupDropIndicator />}
            </div>

            {/* 组内 item 拖动时的浮动预览 */}
            <DragOverlay dropAnimation={dropAnimation}>
              {activeItem ? (
                <ItemOverlay
                  forward={activeItem}
                  instanceHeaders={instanceHeaders ?? null}
                  stats={
                    activeItemGroupIndex !== null
                      ? getForwardGroupStats(instanceName, activeItem.name)[
                          groups[activeItemGroupIndex]?.items.findIndex(
                            (f) => f.id === activeItem.id
                          ) ?? 0
                        ] ?? null
                      : null
                  }
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </CardContent>
    </Card>
  );
}
