import { useId, useMemo, useState } from "react";
import { ZodError } from "zod";
import { Plus, Pencil, Trash2, ChevronDown, ChevronUp, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { API_FORMAT_LABELS, modelRoutingFingerprint } from "@/lib/provider-routing-config";
import {
  createModelRoutingDraft,
  parseModelRoutingDraft,
  type ModelRoutingRow,
} from "@/lib/provider-routing-form";
import {
  createModelRoutingSession,
  type ModelRoutingEditSession,
} from "@/lib/model-routing-drafts";
import { useModelRoutingSession } from "./ModelRoutingDraftProvider";
import type { ApiFormat, ProxyForwardConfig } from "@/types/proxy";

function ModelApiPicker({
  value,
  onChange,
  disabled,
  name,
}: {
  value: ApiFormat[];
  onChange: (formats: ApiFormat[]) => void;
  disabled: boolean;
  name: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-label={`设置 ${name || "新模型"} 的 API`}
          className="h-auto min-h-8 max-w-full justify-start gap-1.5 py-1 text-xs"
        >
          <span className="min-w-0 truncate">
            {value.length === 3
              ? "3 种 API"
              : value.length
                ? value
                    .map((format) =>
                      format === "anthropic-messages" ? "Messages" : API_FORMAT_LABELS[format],
                    )
                    .join(" / ")
                : "API 不限制"}
          </span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2 p-3">
        <p className="text-sm font-medium">该模型支持的客户端 API</p>
        {(Object.keys(API_FORMAT_LABELS) as ApiFormat[]).map((format) => (
          <button
            key={format}
            type="button"
            role="checkbox"
            aria-checked={value.includes(format)}
            disabled={disabled}
            className="hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm outline-none focus-visible:ring-2"
            onClick={() =>
              onChange(
                value.includes(format)
                  ? value.filter((item) => item !== format)
                  : [...value, format],
              )
            }
          >
            <span
              className={`flex size-4 shrink-0 items-center justify-center rounded border ${value.includes(format) ? "bg-primary text-primary-foreground border-primary" : "border-input"}`}
            >
              {value.includes(format) && <Check className="size-3" aria-hidden="true" />}
            </span>
            {API_FORMAT_LABELS[format]}
          </button>
        ))}
        <p className="text-muted-foreground text-xs">
          全部取消表示不限制。只影响该模型，不会自动转换协议。
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function InlineModelRouting({
  forward,
  instanceName,
  onUpdate,
}: {
  forward: ProxyForwardConfig;
  instanceName: string;
  onUpdate: () => void | Promise<void>;
}) {
  const key = JSON.stringify([instanceName, forward.id]);
  const { session, store } = useModelRoutingSession(key);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState("");
  const formId = useId();
  const savedDraft = useMemo(
    () => createModelRoutingDraft(forward.modelRouting),
    [forward.modelRouting],
  );
  const rows = session?.draft.models ?? savedDraft.models;
  const mode = session?.draft.mode ?? forward.modelRouting?.mode ?? "all";
  const busy = Boolean(session?.saving || session?.reloading);
  const showAll = expanded || Boolean(session);
  const conflict = Boolean(
    session &&
    (session.needsReload ||
      modelRoutingFingerprint(session.expected) !== modelRoutingFingerprint(forward.modelRouting)),
  );

  const edit = (update: (current: ModelRoutingEditSession) => ModelRoutingEditSession) => {
    const current = store.get(key) ?? {
      ...createModelRoutingSession(forward.modelRouting),
      draft: savedDraft,
    };
    if (current.saving || current.reloading) return;
    setNotice("");
    store.set(key, update({ ...current, error: "", issues: [] }));
  };
  const updateRow = (index: number, changes: Partial<ModelRoutingRow>) =>
    edit((current) => ({
      ...current,
      draft: {
        ...current.draft,
        models: current.draft.models.map((item, position) =>
          position === index ? { ...item, ...changes } : item,
        ),
      },
    }));
  const reload = async () => {
    const current = store.get(key);
    if (current?.saving || current?.reloading) return;
    if (current) store.set(key, { ...current, reloading: true });
    try {
      const response = await fetch("/api/config");
      if (!response.ok) throw new Error("无法载入配置，请重试");
      await onUpdate();
      store.set(key, undefined);
      setNotice("");
    } catch (error) {
      if (current)
        store.set(key, {
          ...current,
          reloading: false,
          error:
            error instanceof TypeError
              ? "网络连接失败，无法载入配置；草稿已保留，请重试"
              : error instanceof Error
                ? error.message
                : "无法载入配置",
        });
    }
  };
  const save = async () => {
    const current = store.get(key);
    if (!current || current.saving || current.reloading || !forward.id) return;
    let needsReload = false;
    try {
      const modelRouting = parseModelRoutingDraft(current.draft);
      store.set(key, { ...current, saving: true, error: "", issues: [] });
      const response = await fetch(
        `/api/config/instances/${encodeURIComponent(instanceName)}/forwards/${encodeURIComponent(forward.id)}/model-routing`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expected: current.expected, modelRouting }),
        },
      );
      const result = await response.json();
      needsReload = response.status === 409 || response.ok;
      if (!response.ok) throw new Error(result.error || "模型配置保存失败，请重试");
      await onUpdate();
      store.set(key, undefined);
      setNotice("模型配置已保存；按实例自动推送设置生效");
    } catch (error) {
      const issues = error instanceof ZodError ? error.issues : [];
      store.set(key, {
        ...current,
        saving: false,
        needsReload,
        editing: current.draft.models.map((row) => row.key),
        error:
          error instanceof ZodError
            ? "请检查模型配置后重试"
            : error instanceof TypeError
              ? "网络连接失败；草稿已保留，请检查连接后重试"
              : error instanceof Error
                ? error.message
                : "模型配置保存失败",
        issues,
      });
    }
  };

  return (
    <section
      aria-label="模型路由配置"
      data-forward-id={forward.id}
      className="min-w-0 space-y-2 border-t pt-3"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${formId}-mode`} className="text-muted-foreground text-xs">
            接收模型
          </label>
          <select
            id={`${formId}-mode`}
            value={mode}
            disabled={busy || !forward.id}
            onChange={(event) =>
              edit((current) => ({
                ...current,
                draft: { ...current.draft, mode: event.target.value as "all" | "listed" },
              }))
            }
            className="border-input bg-background focus-visible:ring-ring h-8 max-w-full rounded-md border px-2 text-xs outline-none focus-visible:ring-2"
          >
            <option value="all">全部模型（默认）</option>
            <option value="listed">仅表内模型</option>
          </select>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || !forward.id}
          className="h-8 text-xs"
          onClick={() =>
            edit((current) => {
              const row: ModelRoutingRow = {
                key: crypto.randomUUID(),
                name: "",
                aliases: "",
                apiFormats: [],
              };
              return {
                ...current,
                editing: [...current.editing, row.key],
                draft: { ...current.draft, models: [...current.draft.models, row] },
              };
            })
          }
        >
          <Plus className="size-3.5" />
          添加模型
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-1 text-xs">
          {mode === "all"
            ? "全部模型 · 原名透传 · API 不限制"
            : "请至少添加一个模型，或切换为全部模型。"}
        </p>
      ) : (
        <div>
          <div
            aria-hidden="true"
            className="text-muted-foreground hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_4.5rem] gap-3 pb-2 text-xs lg:grid"
          >
            <span>上游模型</span>
            <span>客户端别名（可选）</span>
            <span>支持的 API</span>
            <span className="text-right">操作</span>
          </div>
          {rows.map((row, index) => {
            const active = Boolean(session?.editing.includes(row.key));
            if (!showAll && index >= 3 && !active) return null;
            const fieldErrors =
              session?.issues.filter(
                (issue) => issue.path[0] === "models" && issue.path[1] === index,
              ) ?? [];
            return (
              <div
                key={row.key}
                className="space-y-2 border-t py-2 first:border-t-0"
                data-model-row={index}
              >
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_4.5rem] lg:gap-3">
                  <div className="min-w-0 space-y-1">
                    <label
                      htmlFor={`${formId}-name-${index}`}
                      className="text-muted-foreground block text-xs lg:sr-only"
                    >
                      上游模型
                    </label>
                    {active ? (
                      <Input
                        id={`${formId}-name-${index}`}
                        aria-label={`上游模型 ${index + 1}`}
                        aria-invalid={fieldErrors.some((issue) => issue.path[2] === "name")}
                        value={row.name}
                        disabled={busy}
                        className="h-8 text-xs"
                        placeholder="例如 glm-5.3"
                        autoFocus={!row.name}
                        onChange={(event) => updateRow(index, { name: event.target.value })}
                      />
                    ) : (
                      <span className="block truncate py-1 text-sm font-medium" title={row.name}>
                        {row.name}
                      </span>
                    )}
                  </div>
                  <div className="col-start-1 min-w-0 space-y-1 lg:col-start-auto">
                    <label
                      htmlFor={`${formId}-aliases-${index}`}
                      className="text-muted-foreground block text-xs lg:sr-only"
                    >
                      客户端别名（可选）
                    </label>
                    {active ? (
                      <Input
                        id={`${formId}-aliases-${index}`}
                        aria-label={`客户端别名 ${index + 1}`}
                        aria-invalid={fieldErrors.some((issue) => issue.path[2] === "aliases")}
                        value={row.aliases}
                        disabled={busy}
                        className="h-8 text-xs"
                        placeholder="留空用原名，多个用逗号分隔"
                        onChange={(event) => updateRow(index, { aliases: event.target.value })}
                      />
                    ) : (
                      <span
                        className="text-muted-foreground block truncate py-1 text-xs"
                        title={row.aliases}
                      >
                        {row.aliases || "原名透传"}
                      </span>
                    )}
                  </div>
                  <div className="col-start-1 min-w-0 space-y-1 lg:col-start-auto">
                    <span className="text-muted-foreground block text-xs lg:sr-only">
                      支持的 API
                    </span>
                    <ModelApiPicker
                      name={row.name}
                      value={row.apiFormats}
                      disabled={busy}
                      onChange={(apiFormats) => updateRow(index, { apiFormats })}
                    />
                  </div>
                  <div className="col-start-2 row-start-1 flex items-start justify-end gap-0.5 lg:col-start-auto lg:row-start-auto">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      disabled={busy}
                      aria-label={`编辑模型 ${row.name || index + 1}`}
                      onClick={() =>
                        edit((current) => ({
                          ...current,
                          editing: [...current.editing, current.draft.models[index]!.key],
                        }))
                      }
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      disabled={busy}
                      aria-label={`移除模型 ${row.name || index + 1}`}
                      onClick={() =>
                        edit((current) => ({
                          ...current,
                          draft: {
                            ...current.draft,
                            models: current.draft.models.filter(
                              (_, position) => position !== index,
                            ),
                          },
                        }))
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                {fieldErrors.map((issue, issueIndex) => (
                  <p key={issueIndex} className="text-destructive text-xs">
                    {issue.message}
                  </p>
                ))}
              </div>
            );
          })}
          {rows.length > 3 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy || Boolean(session)}
              onClick={() => setExpanded(!expanded)}
            >
              {showAll ? <ChevronUp /> : <ChevronDown />}
              {showAll ? "收起模型" : `展开其余 ${rows.length - 3} 个模型`}
            </Button>
          )}
        </div>
      )}
      {mode === "all" && rows.length > 0 && (
        <p className="text-muted-foreground text-xs">其他模型仍按原名透传，API 不限制。</p>
      )}
      {session && (
        <div className="space-y-2 border-t pt-3">
          {conflict && (
            <p role="alert" className="text-destructive text-xs">
              模型配置已在其他位置更新，草稿已保留。请载入最新配置后重新编辑。
            </p>
          )}
          {session.error && (
            <p role="alert" className="text-destructive text-xs">
              {session.error}
            </p>
          )}
          {session.issues
            .filter((issue) => issue.path[1] === undefined)
            .map((issue, index) => (
              <p key={index} className="text-destructive text-xs">
                {issue.message}
              </p>
            ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">未保存的模型配置</span>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={reload}>
                {session.reloading ? "载入中…" : conflict ? "载入最新配置" : "取消更改"}
              </Button>
              <Button type="button" size="sm" disabled={busy || conflict} onClick={save}>
                {session.saving && <Loader2 className="size-3.5 animate-spin" />}
                {session.saving ? "保存中…" : "保存模型配置"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="text-muted-foreground text-xs">
          {notice}
        </p>
      )}
    </section>
  );
}
