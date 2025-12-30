import { useEffect, useMemo, useState } from "react";
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
import { ChevronDown, Info, Plus, Trash2, Zap } from "lucide-react";
import type { HookConfig, HooksConfig } from "@/types/proxy";
import { getHookPluginName } from "@/lib/hooks-config";

interface HooksInputProps {
  /** hooks 的 JSON 字符串（空字符串表示 null） */
  value: string;
  onChange: (value: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceHookConfig(value: unknown): HookConfig {
  const obj = isRecord(value) ? value : {};
  const type = "http" as const; // 目前仅支持 http
  const command = typeof obj.command === "string" ? obj.command : "";
  const args =
    Array.isArray(obj.args) && obj.args.every((it) => typeof it === "string")
      ? (obj.args as string[])
      : undefined;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
  const disabled = obj.disabled === true ? true : undefined;
  const config = isRecord(obj.config) ? obj.config : undefined;
  return {
    type,
    command,
    args,
    cwd,
    disabled,
    config,
  };
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

  const hasValue = value && value.trim() !== "";

  const syncHooksToJson = (nextHooks: HookConfig[]) => {
    setHooks(nextHooks);
    const nextJson = nextHooks.length === 0 ? "" : JSON.stringify(nextHooks);
    onChange(nextJson);
    setJsonText(nextHooks.length === 0 ? "" : JSON.stringify(nextHooks, null, 2));
    setJsonError(null);
    setConfigTexts(nextHooks.map((h) => (h.config ? JSON.stringify(h.config, null, 2) : "")));
    setConfigErrors(nextHooks.map(() => null));
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
    const next = [...hooks, hook];
    setIsOpen(true);
    syncHooksToJson(next);
  };

  const handleAddEmpty = () => {
    addHook({ type: "http", command: "bunx", args: [] });
  };

  const handleAddPreset = (presetId: string) => {
    const preset = OFFICIAL_PLUGIN_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    addHook(preset.hook);
  };

  const updateHook = (index: number, updater: (prev: HookConfig) => HookConfig) => {
    const next = hooks.map((h, i) => (i === index ? updater(h) : h));
    syncHooksToJson(next);
  };

  const removeHook = (index: number) => {
    const next = hooks.filter((_, i) => i !== index);
    syncHooksToJson(next);
  };

  const renderSummaryBadges = (hooksConfig: HookConfig[]) => {
    if (hooksConfig.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        {hooksConfig.map((hook, idx) => {
          const pluginName = getHookPluginName(hook);
          const disabled = hook.disabled === true;
          return (
            <Badge
              key={`${pluginName}-${idx}`}
              variant="outline"
              className={`text-[10px] ${disabled ? "opacity-60 border-dashed" : ""}`}
            >
              {pluginName}
              {disabled ? " (disabled)" : ""}
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
          {hasValue && !isOpen && <span className="text-muted-foreground text-xs font-normal">(已配置)</span>}
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
            <TooltipContent className="max-w-sm text-xs leading-relaxed">
              <p className="mb-2">配置插件，用于在转发前后处理请求和响应。</p>
              <p className="mb-1">
                <strong>格式：</strong> 单个插件或插件数组
              </p>
              <pre className="bg-muted rounded p-1 text-[10px]">
                {`[
  {
    "type": "http",
    "disabled": false,
    "command": "bunx",
    "args": ["@jixo/proxy-plugin-xxx"],
    "config": { ... }
  }
]`}
              </pre>
              <p className="mt-2 mb-1">
                <strong>字段：</strong>
              </p>
              <ul className="list-inside list-disc space-y-0.5">
                <li>disabled: 是否禁用（仅用于启停，不参与 hookId 计算）</li>
                <li>type: 目前仅支持 "http"</li>
                <li>command: 启动命令</li>
                <li>args: 命令参数数组</li>
                <li>config: 插件配置（可选）</li>
              </ul>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {isOpen && (
        <div className="space-y-3">
          {/* 工具栏 */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={handleAddEmpty}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                添加 Hook
              </Button>
              <Select onValueChange={handleAddPreset}>
                <SelectTrigger className="h-9 w-[220px]">
                  <SelectValue placeholder="快速添加官方插件" />
                </SelectTrigger>
                <SelectContent>
                  {OFFICIAL_PLUGIN_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {hasValue && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setShowAdvancedJson((v) => !v)}
              >
                {showAdvancedJson ? "隐藏 JSON" : "高级 JSON"}
              </Button>
            )}
          </div>

          {hooks.length === 0 ? (
            <div className="text-muted-foreground text-xs">
              未配置 hooks。你可以点击 “添加 Hook” 或通过 “快速添加官方插件” 一键填充。
            </div>
          ) : (
            <div className="space-y-3">
              {hooks.map((hook, index) => {
                const pluginName = getHookPluginName(hook);
                const disabled = hook.disabled === true;
                const argsText = (hook.args ?? []).join("\n");
                const configText = configTexts[index] ?? "";
                const configError = configErrors[index] ?? null;

                return (
                  <div
                    key={`${pluginName}-${index}`}
                    className={`rounded-lg border p-3 ${disabled ? "opacity-60 bg-muted/20 border-dashed" : "bg-card/40"}`}
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {pluginName}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px]">
                          {hook.type}
                        </Badge>
                        {disabled && (
                          <Badge variant="outline" className="text-[10px] border-dashed">
                            disabled
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
                          <span>{disabled ? "已禁用" : "已启用"}</span>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => removeHook(index)}
                          aria-label="删除 Hook"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Type</Label>
                        <Select
                          value={hook.type}
                          onValueChange={() => {
                            // 目前仅支持 http，保持为 select 以便未来扩展
                          }}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="http">http</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs">Command</Label>
                        <Input
                          value={hook.command}
                          onChange={(e) => updateHook(index, (prev) => ({ ...prev, command: e.target.value }))}
                          placeholder="bunx"
                          className="h-9 font-mono text-xs"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs">CWD (可选)</Label>
                        <Input
                          value={hook.cwd ?? ""}
                          onChange={(e) =>
                            updateHook(index, (prev) => {
                              const cwd = e.target.value.trim();
                              return { ...prev, cwd: cwd.length > 0 ? cwd : undefined };
                            })
                          }
                          placeholder="/path/to/project"
                          className="h-9 font-mono text-xs"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-xs">Args (每行一个)</Label>
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
                          placeholder="@jixo/proxy-plugin-droid"
                          className="font-mono text-xs"
                          rows={3}
                        />
                      </div>

                      <div className="space-y-1.5 md:col-span-2">
                        <Label className="text-xs">Config (可选，JSON)</Label>
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
                                  prev.map((v, i) => (i === index ? "config 必须是 JSON object" : v)),
                                );
                                return;
                              }
                              setConfigErrors((prev) => prev.map((v, i) => (i === index ? null : v)));
                              updateHook(index, (prev) => ({ ...prev, config: raw }));
                            } catch {
                              setConfigErrors((prev) =>
                                prev.map((v, i) => (i === index ? "config JSON 解析失败" : v)),
                              );
                            }
                          }}
                          placeholder={`{\n  "debug": false\n}`}
                          className="font-mono text-xs"
                          rows={6}
                        />
                        {configError && <div className="text-destructive text-xs">{configError}</div>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 高级 JSON（可选） */}
          {showAdvancedJson && (
            <div className="space-y-2">
              <div className="text-muted-foreground text-xs">高级：直接编辑 hooks JSON</div>
              <Textarea
                value={jsonText}
                onChange={(e) => handleAdvancedJsonChange(e.target.value)}
                placeholder="留空表示不使用 hooks"
                className="font-mono text-xs"
                rows={10}
              />
              {jsonError && <p className="text-destructive text-xs">{jsonError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
