import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BodyViewerPlugin,
  Content,
  PluginContext,
} from "@/contexts/BodyViewerPlugin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type {
  EventStreamMessage,
  ConverterInstance,
  ConverterEditorState,
  StepVisibilityMap,
  BuiltInConverterId,
} from "./types";
import { ConverterPanel } from "./ConverterPanel";
import { MessageList } from "./MessageList";
import { parseEventStreamPayload } from "./parser";
import { useEventStreamPipeline, normalizeVisibility } from "./useEventStreamPipeline";
import { Copy, Workflow } from "lucide-react";

const utf8Decoder = new TextDecoder("utf-8");

function createInstanceId() {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function eventStreamViewerPlugin(): BodyViewerPlugin {
  return {
    name: "event-stream-viewer",
    enforce: "core",
    transform(content: Content, ctx: PluginContext) {
      const mime = content.mime?.toLowerCase() ?? "";
      if (!mime.includes("text/event-stream")) return null;
      ctx.registerViewer({
        tab: (
          <span className="flex items-center gap-1">
            <Workflow className="size-3" /> Event Stream
          </span>
        ),
        content: <EventStreamViewerPanel key="event-stream" content={content} ctx={ctx} />,
      });
      return null;
    },
  };
}

function EventStreamViewerPanel({ content, ctx }: { content: Content; ctx: PluginContext }) {
  const messages = useMemo<EventStreamMessage[]>(
    () => parseEventStreamPayload(content.value),
    [content.value],
  );

  const initialConfigRef = useRef<{ converters: ConverterInstance[]; visibility?: StepVisibilityMap } | null>(null);
  if (initialConfigRef.current === null) {
    initialConfigRef.current = (ctx.getConfig?.() as any) ?? null;
  }
  const persisted = initialConfigRef.current;

  const [converters, setConverters] = useState<ConverterInstance[]>(() => {
    if (persisted?.converters?.length) return persisted.converters;
    return [
      {
        instanceId: createInstanceId(),
        kind: "builtin",
        converterId: "auto",
      },
    ];
  });

  const [visibility, setVisibility] = useState<StepVisibilityMap>(() =>
    normalizeVisibility(converters, persisted?.visibility ?? {}),
  );

  useEffect(() => {
    setVisibility((prev) => normalizeVisibility(converters, prev));
  }, [converters]);

  useEffect(() => {
    ctx.setConfig?.({ converters, visibility });
  }, [ctx, converters, visibility]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [editorState, setEditorState] = useState<ConverterEditorState | null>(null);

  const { messageStates } = useEventStreamPipeline(messages, converters);

  const handleCopyRaw = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      ctx.showTip?.({ type: "warning", content: "当前环境无法访问剪贴板" }, 2500);
      return;
    }
    try {
      const raw = utf8Decoder.decode(content.value);
      await navigator.clipboard.writeText(raw);
      ctx.showTip?.({ type: "success", content: "已复制原始 event-stream" }, 2000);
    } catch (error) {
      ctx.showTip?.({ type: "error", content: `复制失败: ${error}` }, 3000);
    }
  }, [content.value, ctx]);

  const handleCopyMessage = useCallback(
    async (message: EventStreamMessage) => {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        ctx.showTip?.({ type: "warning", content: "无法使用剪贴板" }, 2000);
        return;
      }
      try {
        await navigator.clipboard.writeText(message.data);
        ctx.showTip?.({ type: "success", content: `已复制 message #${message.index + 1}` }, 1500);
      } catch (error) {
        ctx.showTip?.({ type: "error", content: `复制失败: ${error}` }, 3000);
      }
    },
    [ctx],
  );

  const handleAddBuiltIn = (id: BuiltInConverterId) => {
    setConverters((prev) => [
      ...prev,
      { instanceId: createInstanceId(), kind: "builtin", converterId: id },
    ]);
    setPickerOpen(false);
  };

  const handleAddExpression = () => {
    setEditorState({ mode: "expression", name: "JS 表达式", code: "text", targetId: undefined });
  };

  const handleAddFunction = () => {
    setEditorState({
      mode: "function",
      name: "JS 转换器",
      code: `export async function transform(text, json, context) {
  // text: 上一个转换器输出的字符串
  // json: try-JSON-parse(text) 的结果，失败为空对象
  return text;
}
`,
    });
  };

  const handleMove = (id: string, dir: -1 | 1) => {
    setConverters((prev) => {
      const index = prev.findIndex((c) => c.instanceId === id);
      if (index === -1) return prev;
      const nextIndex = index + dir;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item!);
      return next;
    });
  };

  const handleEdit = (instance: ConverterInstance) => {
    if (instance.kind === "builtin") return;
    setEditorState({
      mode: instance.kind === "custom-expression" ? "expression" : "function",
      name: instance.name,
      code: instance.kind === "custom-expression" ? instance.expression : instance.source,
      targetId: instance.instanceId,
    });
  };

  const handleRemove = (id: string) => {
    setConverters((prev) => prev.filter((c) => c.instanceId !== id));
  };

  const handleToggleVisibility = (id: string) => {
    setVisibility((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? true),
    }));
  };

  const handleEditorSave = () => {
    if (!editorState) return;
    const name = editorState.name.trim() || (editorState.mode === "expression" ? "JS 表达式" : "JS 转换器");
    const code = editorState.code;
    if (editorState.targetId) {
      setConverters((prev) =>
        prev.map((c) => {
          if (c.instanceId !== editorState.targetId) return c;
          if (editorState.mode === "expression" && c.kind === "custom-expression") {
            return { ...c, name, expression: code };
          }
          if (editorState.mode === "function" && c.kind === "custom-function") {
            return { ...c, name, source: code };
          }
          return c;
        }),
      );
    } else {
      const instanceId = createInstanceId();
      if (editorState.mode === "expression") {
        setConverters((prev) => [
          ...prev,
          {
            instanceId,
            kind: "custom-expression",
            name,
            expression: code,
          },
        ]);
      } else {
        setConverters((prev) => [
          ...prev,
          {
            instanceId,
            kind: "custom-function",
            name,
            source: code,
          },
        ]);
      }
    }
    setEditorState(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium flex items-center gap-2">
            <Workflow className="size-4" /> Event Stream ({messages.length})
          </p>
          <p className="text-xs text-muted-foreground">
            管线对每条 message 生效；转换器可返回高亮对象，自由组合展示
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleCopyRaw}>
          复制原始 Stream
        </Button>
      </div>

      <ConverterPanel
        converters={converters}
        visibility={visibility}
        pickerOpen={pickerOpen}
        onPickerOpenChange={setPickerOpen}
        onAddBuiltIn={handleAddBuiltIn}
        onAddExpression={handleAddExpression}
        onAddFunction={handleAddFunction}
        onMove={handleMove}
        onEdit={handleEdit}
        onRemove={handleRemove}
        onToggleVisibility={handleToggleVisibility}
      />

      <MessageList
        messages={messages}
        states={messageStates}
        visibility={visibility}
        onCopyMessage={handleCopyMessage}
      />

      <Dialog open={!!editorState} onOpenChange={(open) => !open && setEditorState(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editorState?.targetId ? "编辑转换器" : "新增转换器"}
            </DialogTitle>
            <DialogDescription>
              {editorState?.mode === "expression"
                ? "JS 表达式会被包装成 export async function transform(text, json, context) { return (EXPR); }"
                : "请编写 export [async] function transform(text, json, context) {}` 模块；json 为 try-JSON-parse(text) 的结果"}
            </DialogDescription>
          </DialogHeader>
          {editorState && (
            <div className="space-y-3">
              <div>
                <label htmlFor="conv-name" className="text-sm font-medium">
                  显示名称
                </label>
                <Input
                  id="conv-name"
                  value={editorState.name}
                  onChange={(event) =>
                    setEditorState((prev) =>
                      prev ? { ...prev, name: event.target.value } : prev,
                    )
                  }
                />
              </div>
              <div>
                <label htmlFor="conv-code" className="text-sm font-medium">
                  {editorState.mode === "expression" ? "JS 表达式" : "转换器代码"}
                </label>
                <Textarea
                  id="conv-code"
                  className="min-h-[220px] font-mono text-xs"
                  value={editorState.code}
                  onChange={(event) =>
                    setEditorState((prev) =>
                      prev ? { ...prev, code: event.target.value } : prev,
                    )
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditorState(null)}>
              取消
            </Button>
            <Button onClick={handleEditorSave}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
