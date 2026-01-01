import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, Code, GripVertical, Info, Plus, Trash2, Zap } from "lucide-react";
import type { HookConfig } from "@/types/proxy";
import { getHookPluginName } from "@/lib/hooks-config";

interface HooksInputProps {
  value: string;
  onChange: (value: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceHookConfig(value: unknown): HookConfig {
  const obj = isRecord(value) ? value : {};
  const type = "http" as const;
  const command = typeof obj.command === "string" ? obj.command : "";
  const args =
    Array.isArray(obj.args) && obj.args.every((it) => typeof it === "string")
      ? (obj.args as string[])
      : undefined;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
  const disabled = obj.disabled === true ? true : undefined;
  const config = isRecord(obj.config) ? obj.config : undefined;
  return { type, command, args, cwd, disabled, config };
}

function coerceHooksConfigList(value: unknown): HookConfig[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(coerceHookConfig);
}

/** 内部使用的hook结构，包含稳定ID */
interface HookWithId extends HookConfig {
  _id: number;
}

interface SortableHookItemProps {
  id: string;
  hook: HookWithId;
  isExpanded: boolean;
  configText: string;
  configError: string | null;
  onToggleExpand: () => void;
  onUpdate: (updater: (prev: HookConfig) => HookConfig) => void;
  onRemove: () => void;
  onConfigTextChange: (text: string) => void;
  onConfigErrorChange: (error: string | null) => void;
}

function SortableHookItem({
  id,
  hook,
  isExpanded,
  configText,
  configError,
  onToggleExpand,
  onUpdate,
  onRemove,
  onConfigTextChange,
  onConfigErrorChange,
}: SortableHookItemProps) {
  const disabled = hook.disabled === true;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  const pluginName = getHookPluginName(hook);
  const argsPreview = (hook.args ?? []).join(" ");
  const displayTitle = argsPreview ? `${hook.command} ${argsPreview}` : hook.command || pluginName;
  const [localArgsText, setLocalArgsText] = useState((hook.args ?? []).join("\n"));

  // 同步外部变化
  useEffect(() => {
    setLocalArgsText((hook.args ?? []).join("\n"));
  }, [hook.args]);

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggleExpand}>
      <div
        ref={setNodeRef}
        style={style}
        className={`rounded border ${disabled ? "opacity-50 border-dashed bg-muted/5" : "bg-card/20"}`}
      >
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <button
            type="button"
            className="cursor-grab text-muted-foreground hover:text-foreground touch-none"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <CollapsibleTrigger asChild>
            <button type="button" className="text-muted-foreground hover:text-foreground">
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex-1 text-left font-mono text-xs hover:underline truncate"
              title={displayTitle}
            >
              {displayTitle}
            </button>
          </CollapsibleTrigger>
          <Badge variant="secondary" className="text-[9px] px-1 py-0">
            {hook.type}
          </Badge>
          <Switch
            checked={!disabled}
            onCheckedChange={(checked) => {
              onUpdate((prev) => {
                if (checked) {
                  const { disabled: _, ...rest } = prev;
                  return rest;
                }
                return { ...prev, disabled: true };
              });
            }}
          />
          <Button type="button" size="icon" variant="ghost" className="h-6 w-6" onClick={onRemove}>
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        </div>
        <CollapsibleContent>
          <div className="border-t px-2 py-2 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Type</Label>
                <Select value={hook.type} onValueChange={() => {}}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">http</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Command</Label>
                <Input
                  value={hook.command}
                  onChange={(e) => onUpdate((prev) => ({ ...prev, command: e.target.value }))}
                  placeholder="bunx"
                  className="h-7 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">CWD</Label>
                <Input
                  value={hook.cwd ?? ""}
                  onChange={(e) =>
                    onUpdate((prev) => {
                      const cwd = e.target.value.trim();
                      return { ...prev, cwd: cwd || undefined };
                    })
                  }
                  placeholder="/path/to/dir"
                  className="h-7 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Args (每行一个)</Label>
                <Textarea
                  value={localArgsText}
                  onChange={(e) => setLocalArgsText(e.target.value)}
                  onBlur={() => {
                    const lines = localArgsText
                      .split("\n")
                      .map((l) => l.trim())
                      .filter((l) => l.length > 0);
                    onUpdate((prev) => ({
                      ...prev,
                      args: lines.length > 0 ? lines : undefined,
                    }));
                  }}
                  placeholder="@jixo/proxy-plugin-xxx"
                  className="font-mono text-xs resize-none"
                  rows={2}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Config (JSON)</Label>
              <Textarea
                value={configText}
                onChange={(e) => {
                  const text = e.target.value;
                  onConfigTextChange(text);
                  if (!text.trim()) {
                    onConfigErrorChange(null);
                    onUpdate((prev) => {
                      const { config: _, ...rest } = prev;
                      return rest;
                    });
                    return;
                  }
                  try {
                    const raw: unknown = JSON.parse(text);
                    if (!isRecord(raw)) {
                      onConfigErrorChange("必须是 object");
                      return;
                    }
                    onConfigErrorChange(null);
                    onUpdate((prev) => ({ ...prev, config: raw }));
                  } catch {
                    onConfigErrorChange("JSON 格式错误");
                  }
                }}
                placeholder='{ "debug": false }'
                className="font-mono text-xs resize-none"
                rows={3}
              />
              {configError && <div className="text-destructive text-[10px]">{configError}</div>}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

type HookPluginsResponse = {
  plugins: string[];
};

export function HooksInput({ value, onChange }: HooksInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [showAdvancedJson, setShowAdvancedJson] = useState(false);
  const [hooks, setHooks] = useState<HookWithId[]>([]);
  const [configTexts, setConfigTexts] = useState<Map<number, string>>(new Map());
  const [configErrors, setConfigErrors] = useState<Map<number, string | null>>(new Map());
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [availablePlugins, setAvailablePlugins] = useState<string[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState<string | null>(null);

  const idCounterRef = useRef(0);
  const hasValue = value && value.trim() !== "";

  /** 去掉内部ID，转为纯HookConfig */
  const stripIds = (list: HookWithId[]): HookConfig[] =>
    list.map(({ _id, ...rest }) => rest);

  const syncToParent = (nextHooks: HookWithId[]) => {
    const pure = stripIds(nextHooks);
    onChange(pure.length === 0 ? "" : JSON.stringify(pure));
    setJsonText(pure.length === 0 ? "" : JSON.stringify(pure, null, 2));
    setJsonError(null);
  };

  const parsed = useMemo(() => {
    if (!hasValue) {
      return { list: [] as HookConfig[], pretty: "", error: null as string | null };
    }
    try {
      const raw: unknown = JSON.parse(value);
      const list = coerceHooksConfigList(raw);
      return { list, pretty: JSON.stringify(raw, null, 2), error: null as string | null };
    } catch {
      return { list: [] as HookConfig[], pretty: value, error: "JSON 解析失败：请检查格式" };
    }
  }, [hasValue, value]);

  useEffect(() => {
    if (!hasValue) {
      setIsOpen(false);
      setShowAdvancedJson(false);
      setJsonText("");
      setJsonError(null);
      setHooks([]);
      setConfigTexts(new Map());
      setConfigErrors(new Map());
      setExpandedId(null);
      idCounterRef.current = 0;
      return;
    }
    setIsOpen(true);
    setJsonText(parsed.pretty);
    setJsonError(parsed.error);
    // 分配稳定ID
    const newHooks = parsed.list.map((h) => ({ ...h, _id: idCounterRef.current++ }));
    setHooks(newHooks);
    const texts = new Map<number, string>();
    newHooks.forEach((h) => texts.set(h._id, h.config ? JSON.stringify(h.config, null, 2) : ""));
    setConfigTexts(texts);
    setConfigErrors(new Map());
  }, [hasValue, parsed.error, parsed.list, parsed.pretty]);

  useEffect(() => {
    let cancelled = false;
    setPluginsLoading(true);
    setPluginsError(null);

    fetch("/api/hook-plugins")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as HookPluginsResponse;
      })
      .then((data) => {
        if (cancelled) return;
        const plugins = Array.isArray(data.plugins)
          ? data.plugins.filter((p) => typeof p === "string")
          : [];
        setAvailablePlugins(plugins);
      })
      .catch((err) => {
        if (cancelled) return;
        setPluginsError(err instanceof Error ? err.message : String(err));
        setAvailablePlugins([]);
      })
      .finally(() => {
        if (cancelled) return;
        setPluginsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleAdvancedJsonChange = (text: string) => {
    setJsonText(text);
    if (!text.trim()) {
      setJsonError(null);
      setHooks([]);
      onChange("");
      return;
    }
    try {
      const raw: unknown = JSON.parse(text);
      const list = coerceHooksConfigList(raw);
      const newHooks = list.map((h) => ({ ...h, _id: idCounterRef.current++ }));
      setHooks(newHooks);
      setJsonError(null);
      syncToParent(newHooks);
    } catch {
      setJsonError("JSON 解析失败：请检查格式");
    }
  };

  const addHook = (hook: HookConfig) => {
    const newHook: HookWithId = { ...hook, _id: idCounterRef.current++ };
    const next = [newHook, ...hooks];
    setHooks(next);
    setIsOpen(true);
    setExpandedId(newHook._id);
    setConfigTexts((prev) => new Map(prev).set(newHook._id, hook.config ? JSON.stringify(hook.config, null, 2) : ""));
    syncToParent(next);
  };

  const handleAddEmpty = () => {
    addHook({ type: "http", command: "bunx", args: [] });
  };

  const handleAddPlugin = (packageName: string) => {
    if (!packageName) return;
    addHook({ type: "http", command: "bunx", args: [packageName] });
  };

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const updateHook = (id: number, updater: (prev: HookConfig) => HookConfig) => {
    const next = hooks.map((h) => (h._id === id ? { ...updater(h), _id: h._id } : h));
    setHooks(next);
    syncToParent(next);
  };

  const removeHook = (id: number) => {
    const next = hooks.filter((h) => h._id !== id);
    setHooks(next);
    if (expandedId === id) setExpandedId(null);
    syncToParent(next);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const hookIds = useMemo(() => hooks.map((h) => `hook-${h._id}`), [hooks]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = hooks.findIndex((h) => `hook-${h._id}` === active.id);
    const newIndex = hooks.findIndex((h) => `hook-${h._id}` === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newHooks = arrayMove(hooks, oldIndex, newIndex);
    setHooks(newHooks);
    syncToParent(newHooks);
  };

  const handleDragCancel = () => {
    setActiveId(null);
  };

  const activeHook = useMemo(() => {
    if (!activeId) return null;
    return hooks.find((h) => `hook-${h._id}` === activeId) ?? null;
  }, [activeId, hooks]);

  const renderSummaryBadges = (hooksConfig: HookConfig[]) => {
    if (hooksConfig.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-1">
        {hooksConfig.map((hook, idx) => {
          const pluginName = getHookPluginName(hook);
          const disabled = hook.disabled === true;
          return (
            <Badge
              key={`${pluginName}-${idx}`}
              variant="outline"
              className={`text-[10px] ${disabled ? "opacity-50 border-dashed" : ""}`}
            >
              {pluginName}
            </Badge>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 text-sm font-medium hover:underline"
        >
          <Zap className="h-3.5 w-3.5" />
          Hooks 配置
          <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
          {hasValue && !isOpen && (
            <span className="text-muted-foreground text-xs font-normal">({hooks.length})</span>
          )}
        </button>
        <div className="flex items-center gap-2">
          {hasValue && !isOpen && renderSummaryBadges(parsed.list)}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center"
              >
                <Info className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              配置插件处理请求/响应。disabled 仅控制启停，不影响 hookId。
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {isOpen && (
        <div className="space-y-2">
          {/* 工具栏 */}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={handleAddEmpty}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              添加
            </Button>
            <Select onValueChange={handleAddPlugin}>
              <SelectTrigger className="h-8 w-[180px] text-xs">
                <SelectValue
                  placeholder={pluginsLoading ? "加载插件中..." : "内置 hooks"}
                />
              </SelectTrigger>
              <SelectContent>
                {pluginsError ? (
                  <SelectItem value="__error__" disabled className="text-xs">
                    加载失败：{pluginsError}
                  </SelectItem>
                ) : availablePlugins.length === 0 ? (
                  <SelectItem value="__empty__" disabled className="text-xs">
                    未发现插件（需要包名匹配 @jixo/proxy-plugin-*）
                  </SelectItem>
                ) : (
                  availablePlugins.map((pkg) => (
                    <SelectItem key={pkg} value={pkg} className="text-xs">
                      {pkg}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {hasValue && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setShowAdvancedJson((v) => !v)}
              >
                <Code className="mr-1 h-3.5 w-3.5" />
                JSON
              </Button>
            )}
          </div>

          {hooks.length === 0 ? (
            <div className="text-muted-foreground text-xs py-2">未配置 hooks</div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext items={hookIds} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {hooks.map((hook) => (
                    <SortableHookItem
                      key={hook._id}
                      id={`hook-${hook._id}`}
                      hook={hook}
                      isExpanded={expandedId === hook._id}
                      configText={configTexts.get(hook._id) ?? ""}
                      configError={configErrors.get(hook._id) ?? null}
                      onToggleExpand={() => toggleExpand(hook._id)}
                      onUpdate={(updater) => updateHook(hook._id, updater)}
                      onRemove={() => removeHook(hook._id)}
                      onConfigTextChange={(text) =>
                        setConfigTexts((prev) => new Map(prev).set(hook._id, text))
                      }
                      onConfigErrorChange={(err) =>
                        setConfigErrors((prev) => new Map(prev).set(hook._id, err))
                      }
                    />
                  ))}
                </div>
              </SortableContext>
              {createPortal(
                <DragOverlay>
                  {activeHook ? (
                    <div className="rounded border bg-card shadow-lg ring-2 ring-primary/50 opacity-90">
                      <div className="flex items-center gap-1.5 px-2 py-1.5">
                        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs">
                          {activeHook.command} {(activeHook.args ?? []).join(" ")}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </DragOverlay>,
                document.body,
              )}
            </DndContext>
          )}

          {showAdvancedJson && (
            <div className="space-y-1 pt-2 border-t">
              <Label className="text-[10px] text-muted-foreground">高级 JSON 编辑</Label>
              <Textarea
                value={jsonText}
                onChange={(e) => handleAdvancedJsonChange(e.target.value)}
                placeholder="[]"
                className="font-mono text-xs"
                rows={8}
              />
              {jsonError && <p className="text-destructive text-[10px]">{jsonError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
