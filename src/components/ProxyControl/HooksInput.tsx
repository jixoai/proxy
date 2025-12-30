import { useEffect, useMemo, useRef, useState } from "react";
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
import { ChevronDown, ChevronRight, Code, Info, Plus, Trash2, Zap } from "lucide-react";
import type { HookConfig, HooksConfig } from "@/types/proxy";
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

const OFFICIAL_PLUGIN_PRESETS = [
  {
    id: "proxy-anthropic-ping",
    label: "@jixo/proxy-anthropic-ping",
    hook: {
      type: "http",
      command: "bunx",
      args: ["@jixo/proxy-anthropic-ping"],
      config: {
        maxKeepAliveDurationMs: 60 * 60 * 1000,
        cacheTtlMs: 5 * 60 * 1000,
        pingLeadTimeMs: 60 * 1000,
        pollingIntervalMs: 30 * 1000,
        debug: false,
      },
    } satisfies HookConfig,
  },
  {
    id: "proxy-plugin-droid",
    label: "@jixo/proxy-plugin-droid",
    hook: {
      type: "http",
      command: "bunx",
      args: ["@jixo/proxy-plugin-droid"],
    } satisfies HookConfig,
  },
] as const;

export function HooksInput({ value, onChange }: HooksInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [showAdvancedJson, setShowAdvancedJson] = useState(false);
  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [configTexts, setConfigTexts] = useState<string[]>([]);
  const [configErrors, setConfigErrors] = useState<(string | null)[]>([]);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const hasValue = value && value.trim() !== "";

  const syncHooksToJson = (nextHooks: HookConfig[], newlyAddedIndex?: number) => {
    setHooks(nextHooks);
    const nextJson = nextHooks.length === 0 ? "" : JSON.stringify(nextHooks);
    onChange(nextJson);
    setJsonText(nextHooks.length === 0 ? "" : JSON.stringify(nextHooks, null, 2));
    setJsonError(null);
    setConfigTexts(nextHooks.map((h) => (h.config ? JSON.stringify(h.config, null, 2) : "")));
    setConfigErrors(nextHooks.map(() => null));
    if (newlyAddedIndex !== undefined) {
      setExpandedIndex(newlyAddedIndex);
    }
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
      setConfigTexts([]);
      setConfigErrors([]);
      return;
    }
    setIsOpen(true);
    setJsonText(parsed.pretty);
    setJsonError(parsed.error);
    setHooks(parsed.list);
    setConfigTexts(parsed.list.map((h) => (h.config ? JSON.stringify(h.config, null, 2) : "")));
    setConfigErrors(parsed.list.map(() => null));
  }, [hasValue, parsed.error, parsed.list, parsed.pretty]);

  const handleAdvancedJsonChange = (text: string) => {
    setJsonText(text);
    if (!text.trim()) {
      setJsonError(null);
      syncHooksToJson([]);
      return;
    }
    try {
      const raw: unknown = JSON.parse(text);
      const list = coerceHooksConfigList(raw);
      setJsonError(null);
      syncHooksToJson(list);
    } catch {
      setJsonError("JSON 解析失败：请检查格式");
    }
  };

  const addHook = (hook: HookConfig) => {
    const next = [hook, ...hooks];
    setIsOpen(true);
    syncHooksToJson(next, 0);
  };

  const handleAddEmpty = () => {
    addHook({ type: "http", command: "bunx", args: [] });
  };

  const handleAddPreset = (presetId: string) => {
    const preset = OFFICIAL_PLUGIN_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    addHook(preset.hook);
  };

  const toggleExpand = (index: number) => {
    setExpandedIndex((prev) => (prev === index ? null : index));
  };

  const updateHook = (index: number, updater: (prev: HookConfig) => HookConfig) => {
    const next = hooks.map((h, i) => (i === index ? updater(h) : h));
    syncHooksToJson(next);
  };

  const removeHook = (index: number) => {
    const next = hooks.filter((_, i) => i !== index);
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) setExpandedIndex(expandedIndex - 1);
    syncHooksToJson(next);
  };

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
            <Select onValueChange={handleAddPreset}>
              <SelectTrigger className="h-8 w-[180px] text-xs">
                <SelectValue placeholder="官方插件" />
              </SelectTrigger>
              <SelectContent>
                {OFFICIAL_PLUGIN_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.label}
                  </SelectItem>
                ))}
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
            <div className="space-y-1.5">
              {hooks.map((hook, index) => {
                const pluginName = getHookPluginName(hook);
                const disabled = hook.disabled === true;
                const isExpanded = expandedIndex === index;
                const argsText = (hook.args ?? []).join("\n");
                const configText = configTexts[index] ?? "";
                const configError = configErrors[index] ?? null;

                return (
                  <Collapsible
                    key={`hook-${index}`}
                    open={isExpanded}
                    onOpenChange={() => toggleExpand(index)}
                  >
                    <div
                      className={`rounded border ${
                        disabled ? "opacity-50 border-dashed bg-muted/5" : "bg-card/20"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 px-2 py-1.5">
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
                            className="flex-1 text-left font-mono text-xs hover:underline"
                          >
                            {pluginName}
                          </button>
                        </CollapsibleTrigger>
                        <Badge variant="secondary" className="text-[9px] px-1 py-0">
                          {hook.type}
                        </Badge>
                        <Switch
                          checked={!disabled}
                          onCheckedChange={(checked) => {
                            updateHook(index, (prev) => {
                              if (checked) {
                                const { disabled: _, ...rest } = prev;
                                return rest;
                              }
                              return { ...prev, disabled: true };
                            });
                          }}
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => removeHook(index)}
                        >
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
                                onChange={(e) =>
                                  updateHook(index, (prev) => ({ ...prev, command: e.target.value }))
                                }
                                placeholder="bunx"
                                className="h-7 font-mono text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[10px] text-muted-foreground">CWD</Label>
                              <Input
                                value={hook.cwd ?? ""}
                                onChange={(e) =>
                                  updateHook(index, (prev) => {
                                    const cwd = e.target.value.trim();
                                    return { ...prev, cwd: cwd || undefined };
                                  })
                                }
                                placeholder="/path/to/dir"
                                className="h-7 font-mono text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[10px] text-muted-foreground">Args</Label>
                              <Textarea
                                value={argsText}
                                onChange={(e) => {
                                  const lines = e.target.value
                                    .split("\n")
                                    .map((l) => l.trim())
                                    .filter((l) => l.length > 0);
                                  updateHook(index, (prev) => ({
                                    ...prev,
                                    args: lines.length > 0 ? lines : undefined,
                                  }));
                                }}
                                placeholder="每行一个参数"
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
                                setConfigTexts((prev) => prev.map((v, i) => (i === index ? text : v)));
                                if (!text.trim()) {
                                  setConfigErrors((prev) => prev.map((v, i) => (i === index ? null : v)));
                                  updateHook(index, (prev) => {
                                    const { config: _, ...rest } = prev;
                                    return rest;
                                  });
                                  return;
                                }
                                try {
                                  const raw: unknown = JSON.parse(text);
                                  if (!isRecord(raw)) {
                                    setConfigErrors((prev) =>
                                      prev.map((v, i) => (i === index ? "必须是 object" : v)),
                                    );
                                    return;
                                  }
                                  setConfigErrors((prev) => prev.map((v, i) => (i === index ? null : v)));
                                  updateHook(index, (prev) => ({ ...prev, config: raw }));
                                } catch {
                                  setConfigErrors((prev) =>
                                    prev.map((v, i) => (i === index ? "JSON 格式错误" : v)),
                                  );
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
              })}
            </div>
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
