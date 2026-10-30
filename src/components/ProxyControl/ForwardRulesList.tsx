import { useState, useEffect, useRef, useMemo, useCallback, useId } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
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
import {
  ArrowRight,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  GripVertical,
} from "lucide-react";
import { CreateForwardDialog } from "./CreateForwardDialog";
import { ForwardRuleItem } from "./ForwardRuleItem";
import type { ProxyConfigFile, ProxyForwardConfig } from "@/types/proxy";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import { normalizeForwardGroups, normalizePathname } from "@/lib/forward-utils";
import { useForwardStats } from "@/hooks/useForwardStats";
import {
  readCollapsedForwardGroups,
  writeCollapsedForwardGroups,
} from "@/lib/forward-group-preferences";

interface ForwardRulesListProps {
  instanceName: string;
  focusedForwardName?: string | null;
}

interface ForwardWithIndex extends ProxyForwardConfig {
  originalIndex: number;
}

interface ForwardGroup {
  id: string;
  name: string;
  items: ForwardWithIndex[];
}

const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.5" } },
  }),
};

function DraggableGroup({
  group,
  isMultiItemGroup,
  children,
  isDragging,
  onDragStart,
  collapsed,
  onToggle,
}: {
  group: ForwardGroup;
  isMultiItemGroup: boolean;
  children?: React.ReactNode;
  isDragging: boolean;
  onDragStart: (groupId: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const contentId = useId();
  return (
    <div
      className={`bg-card/50 rounded-lg border transition-shadow ${isDragging ? "opacity-40" : ""}`}
    >
      <div
        className={`bg-muted/40 flex items-center gap-1 px-2 ${collapsed ? "rounded-lg" : "rounded-t-lg border-b"}`}
      >
        <span
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            onDragStart(group.id);
          }}
          title={`拖动分组 ${group.name}`}
          className="text-muted-foreground flex size-8 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </span>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          aria-label={`${collapsed ? "展开" : "折叠"}分组 ${group.name}`}
          onClick={onToggle}
          className="hover:bg-muted/60 focus-visible:ring-ring flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-2 pr-2 text-left text-sm font-medium outline-none focus-visible:ring-2"
        >
          <ChevronRight
            className={`text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none ${collapsed ? "" : "rotate-90"}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate" title={group.name}>
            {group.name}
          </span>
          {isMultiItemGroup && (
            <span className="text-muted-foreground hidden text-xs font-normal sm:inline">
              同名规则为一组，失败自动在组内切换
            </span>
          )}
          <span className="text-muted-foreground shrink-0 text-xs font-normal tabular-nums">
            {group.items.length} 条
          </span>
        </button>
      </div>
      <div id={contentId} hidden={collapsed}>
        {collapsed ? null : children}
      </div>
    </div>
  );
}

function GroupDropIndicator() {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="bg-primary h-0.5 flex-1 rounded" />
      <div className="bg-primary h-2 w-2 rounded-full" />
      <div className="bg-primary h-0.5 flex-1 rounded" />
    </div>
  );
}

function SortableItem({
  id,
  forward,
  instanceName,
  instanceHeaders,
  onUpdate,
  highlighted,
  priorRuleName,
  showDragHandle,
  stats,
  focusedForwardIndex,
  clearControlFocus,
  itemRefs,
  isDragOverlay = false,
}: {
  id: string;
  forward: ForwardWithIndex;
  instanceName: string;
  instanceHeaders: Record<string, string> | null;
  onUpdate: () => void;
  highlighted: boolean;
  priorRuleName: string | null;
  showDragHandle: boolean;
  stats: any;
  focusedForwardIndex: number | null;
  clearControlFocus: () => void;
  itemRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
  isDragOverlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !showDragHandle,
  });

  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        if (el) itemRefs.current.set(forward.originalIndex, el);
        else itemRefs.current.delete(forward.originalIndex);
      }}
      style={style}
      onClick={() => {
        if (focusedForwardIndex === forward.originalIndex) clearControlFocus();
      }}
      className={`transition-opacity ${isDragging && !isDragOverlay ? "opacity-40" : ""} ${
        isDragOverlay ? "ring-primary/50 rounded-lg shadow-xl ring-2" : ""
      }`}
    >
      <ForwardRuleItem
        forward={forward}
        forwardIndex={forward.originalIndex}
        instanceName={instanceName}
        onUpdate={onUpdate}
        highlighted={highlighted}
        instanceHeaders={instanceHeaders}
        priorRuleName={priorRuleName}
        showName={false}
        showDragHandle={showDragHandle}
        dragHandleProps={showDragHandle ? { ...attributes, ...listeners } : undefined}
        stats={stats}
      />
    </div>
  );
}

export function ForwardRulesList(props: ForwardRulesListProps) {
  return <InstanceForwardRulesList key={props.instanceName} {...props} />;
}

function InstanceForwardRulesList({ instanceName, focusedForwardName }: ForwardRulesListProps) {
  const [forwards, setForwards] = useState<ForwardWithIndex[]>([]);
  const [configData, setConfigData] = useState<ProxyConfigFile | null>(null);
  const [instanceHeaders, setInstanceHeaders] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingOrder, setSavingOrder] = useState(false);
  const [autoSortEnabled, setAutoSortEnabled] = useState(false);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [groupDropIndex, setGroupDropIndex] = useState<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState(() =>
    readCollapsedForwardGroups(instanceName),
  );
  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const { clearControlFocus, configVersion } = useProxyViewer();
  const { getStats } = useForwardStats();
  const focusedGroupCollapsed =
    focusedForwardName != null && collapsedGroups.has(focusedForwardName);

  useEffect(() => {
    writeCollapsedForwardGroups(instanceName, collapsedGroups);
  }, [instanceName, collapsedGroups]);

  // 计算 focusedForwardIndex：根据 focusedForwardName 找到第一个匹配的 forward 的 originalIndex
  const focusedForwardIndex = useMemo(() => {
    if (!focusedForwardName) return null;
    const found = forwards.find((f) => f.name === focusedForwardName);
    return found?.originalIndex ?? null;
  }, [focusedForwardName, forwards]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const loadForwards = useCallback(async () => {
    try {
      const response = await fetch("/api/config");
      const config: ProxyConfigFile = await response.json();
      setConfigData(config);

      const instance = config.instances.find((i) => i.name === instanceName);
      if (instance) {
        const forwardsList = instance.forwards.map((f, idx) => ({ ...f, originalIndex: idx }));
        setForwards(normalizeForwardGroups(forwardsList));
        setAutoSortEnabled(instance.settings?.autoSortSameNameForwards ?? false);
        setInstanceHeaders(instance.headers);
      } else {
        setForwards([]);
        setInstanceHeaders(null);
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    } finally {
      setLoading(false);
    }
  }, [instanceName]);

  useEffect(() => {
    loadForwards();
  }, [loadForwards, configVersion]);

  const handleAutoSortToggle = async (enabled: boolean) => {
    if (!configData) return;
    setAutoSortEnabled(enabled);
    try {
      const newConfig = { ...configData };
      const idx = newConfig.instances.findIndex((i) => i.name === instanceName);
      if (idx === -1) return;

      newConfig.instances[idx] = {
        ...newConfig.instances[idx]!,
        settings: { ...newConfig.instances[idx]!.settings, autoSortSameNameForwards: enabled },
      };

      const resp = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });
      if (resp.ok) setConfigData(newConfig);
      else setAutoSortEnabled(!enabled);
    } catch {
      setAutoSortEnabled(!enabled);
    }
  };

  const buildGroups = (list: ForwardWithIndex[]): ForwardGroup[] => {
    const grouped: ForwardGroup[] = [];
    for (const item of list) {
      const last = grouped.at(-1);
      if (!last || last.name !== item.name) {
        grouped.push({ id: `group-${item.name}`, name: item.name, items: [item] });
      } else {
        last.items.push(item);
      }
    }
    return grouped;
  };

  const groups = useMemo(() => buildGroups(forwards), [forwards]);
  const allGroupsExpanded = groups.every((group) => !collapsedGroups.has(group.name));
  const allGroupsCollapsed = groups.every((group) => collapsedGroups.has(group.name));

  const toggleGroup = (groupName: string) => {
    if (focusedForwardName === groupName) clearControlFocus();
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  };

  const collapseAllGroups = () => {
    clearControlFocus();
    setCollapsedGroups(new Set(groups.map((group) => group.name)));
  };

  const saveOrder = useCallback(
    async (currentForwards: ForwardWithIndex[]) => {
      if (!configData) return;
      setSavingOrder(true);
      try {
        const newConfig = { ...configData };
        const idx = newConfig.instances.findIndex((i) => i.name === instanceName);
        if (idx === -1) return;

        const instance = newConfig.instances[idx]!;
        const oldForwards = instance.forwards;
        const newForwards = currentForwards.map((f) => oldForwards[f.originalIndex]!);

        newConfig.instances[idx] = { ...instance, forwards: newForwards };

        const resp = await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newConfig),
        });
        if (resp.ok) setConfigData(newConfig);
        else await loadForwards();
      } catch {
        await loadForwards();
      } finally {
        setSavingOrder(false);
      }
    },
    [configData, instanceName, loadForwards],
  );

  const handleAutoSort = async () => {
    if (forwards.length === 0) return;
    const sorted = normalizeForwardGroups(forwards);
    setForwards(sorted);
    await saveOrder(sorted);
  };

  const handleGroupDragStart = useCallback((groupId: string) => {
    setDraggingGroupId(groupId);
    setGroupDropIndex(null);
  }, []);

  const handleGroupDragOver = useCallback(
    (e: React.DragEvent, targetIndex: number) => {
      e.preventDefault();
      if (!draggingGroupId) return;
      const draggingIndex = groups.findIndex((g) => g.id === draggingGroupId);
      if (draggingIndex === -1) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const insertBefore = e.clientY < rect.top + rect.height / 2;
      const dropIndex = insertBefore ? targetIndex : targetIndex + 1;

      if (dropIndex === draggingIndex || dropIndex === draggingIndex + 1) setGroupDropIndex(null);
      else setGroupDropIndex(dropIndex);
    },
    [draggingGroupId, groups],
  );

  const handleGroupDragEnd = useCallback(
    (e?: React.DragEvent) => {
      e?.stopPropagation();
      if (!draggingGroupId) return;

      const currentDraggingId = draggingGroupId;
      const currentDropIndex = groupDropIndex;
      setDraggingGroupId(null);
      setGroupDropIndex(null);

      if (currentDropIndex === null) return;
      const oldIndex = groups.findIndex((g) => g.id === currentDraggingId);
      if (oldIndex === -1) return;

      let newIndex = currentDropIndex > oldIndex ? currentDropIndex - 1 : currentDropIndex;
      if (oldIndex !== newIndex) {
        const newGroups = arrayMove(groups, oldIndex, newIndex);
        const newForwards = newGroups.flatMap((g) => g.items);
        setForwards(newForwards);
        saveOrder(newForwards);
      }
    },
    [draggingGroupId, groupDropIndex, groups, saveOrder],
  );

  const activeItem = useMemo(() => {
    if (!activeId) return null;
    const id = String(activeId);
    if (id.startsWith("item-")) {
      const idx = Number(id.replace("item-", ""));
      for (const group of groups) {
        const found = group.items.find((f) => f.originalIndex === idx);
        if (found) return found;
      }
    }
    return null;
  }, [activeId, groups]);

  const handleDragStart = (event: DragStartEvent) => setActiveId(event.active.id);
  const handleDragCancel = () => setActiveId(null);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);
    if (activeIdStr === overIdStr) return;

    if (activeIdStr.startsWith("item-") && overIdStr.startsWith("item-")) {
      const activeIdx = Number(activeIdStr.replace("item-", ""));
      const overIdx = Number(overIdStr.replace("item-", ""));

      let activeGroupIdx = -1,
        activeItemIdx = -1,
        overGroupIdx = -1,
        overItemIdx = -1;

      groups.forEach((group, gIdx) => {
        group.items.forEach((item, iIdx) => {
          if (item.originalIndex === activeIdx) {
            activeGroupIdx = gIdx;
            activeItemIdx = iIdx;
          }
          if (item.originalIndex === overIdx) {
            overGroupIdx = gIdx;
            overItemIdx = iIdx;
          }
        });
      });

      if (activeGroupIdx === overGroupIdx && activeGroupIdx !== -1) {
        const group = groups[activeGroupIdx]!;
        if (activeItemIdx !== overItemIdx) {
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
    if (focusedForwardName == null || focusedForwardIndex == null) return;
    setCollapsedGroups((current) => {
      if (!current.has(focusedForwardName)) return current;
      const next = new Set(current);
      next.delete(focusedForwardName);
      return next;
    });
  }, [focusedForwardName, focusedForwardIndex]);

  useEffect(() => {
    if (focusedForwardIndex == null || focusedGroupCollapsed) return;
    const tryScroll = () => {
      const target = itemRefs.current.get(focusedForwardIndex);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return true;
      }
      return false;
    };
    // 立即尝试，如果失败则延迟重试（等待DOM更新）
    if (!tryScroll()) {
      const timer = setTimeout(tryScroll, 100);
      return () => clearTimeout(timer);
    }
  }, [focusedForwardIndex, forwards, focusedGroupCollapsed]);

  /** 返回被哪个规则优先匹配（返回上方规则名称，null 表示不会被其他规则优先） */
  const priorRuleNames = useMemo(() => {
    const seen = new Map<string, string>();
    const flags = new Map<number, string | null>();
    forwards.forEach((forward) => {
      const pathKey = normalizePathname(forward.path ?? "/");
      const ownerName = seen.get(pathKey);
      const priorName = ownerName !== undefined && ownerName !== forward.name ? ownerName : null;
      flags.set(forward.originalIndex, priorName);
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">转发规则</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
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
            <CreateForwardDialog instanceName={instanceName} onCreated={loadForwards} />
          </div>
        </div>
        {groups.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              {groups.length} 个分组 · {forwards.length} 条规则
            </span>
            <div role="group" aria-label="分组展开状态" className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={collapseAllGroups}
                disabled={allGroupsCollapsed}
              >
                <ChevronsDownUp aria-hidden="true" />
                全部折叠
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setCollapsedGroups(new Set())}
                disabled={allGroupsExpanded}
              >
                <ChevronsUpDown aria-hidden="true" />
                全部展开
              </Button>
            </div>
          </div>
        )}
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
                instanceName={instanceName}
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
                if (draggingGroupId && e.target === e.currentTarget) {
                  e.preventDefault();
                  setGroupDropIndex(groups.length);
                }
              }}
              onDrop={handleGroupDragEnd}
            >
              {groups.map((group, groupIndex) => {
                const isMultiItemGroup = group.items.length > 1;
                const itemIds = group.items.map((f) => `item-${f.originalIndex}`);
                const isDraggingThisGroup = draggingGroupId === group.id;

                return (
                  <div key={group.id}>
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
                        collapsed={collapsedGroups.has(group.name)}
                        onToggle={() => toggleGroup(group.name)}
                      >
                        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
                          <div className="flex flex-col gap-2 p-2">
                            {group.items.map((forward, itemIndex) => (
                              <SortableItem
                                key={forward.originalIndex}
                                id={`item-${forward.originalIndex}`}
                                forward={forward}
                                instanceName={instanceName}
                                instanceHeaders={instanceHeaders}
                                onUpdate={loadForwards}
                                highlighted={focusedForwardIndex === forward.originalIndex}
                                priorRuleName={priorRuleNames.get(forward.originalIndex) ?? null}
                                showDragHandle={isMultiItemGroup}
                                stats={forward.id ? getStats(forward.id) : null}
                                focusedForwardIndex={focusedForwardIndex ?? null}
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
              {groupDropIndex === groups.length && <GroupDropIndicator />}
            </div>

            <DragOverlay dropAnimation={dropAnimation}>
              {activeItem ? (
                <div className="ring-primary/50 rounded-lg shadow-xl ring-2">
                  <ForwardRuleItem
                    forward={activeItem}
                    forwardIndex={activeItem.originalIndex}
                    instanceName={instanceName}
                    onUpdate={() => {}}
                    highlighted={false}
                    instanceHeaders={instanceHeaders}
                    priorRuleName={null}
                    showName={false}
                    showDragHandle={true}
                    stats={null}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </CardContent>
    </Card>
  );
}
