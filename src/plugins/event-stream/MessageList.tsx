import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Copy } from "lucide-react";
import type { EventStreamMessage, MessagePipelineState, StepVisibilityMap } from "./types";
import { StepOutput } from "./StepOutput";

interface MessageListProps {
  messages: EventStreamMessage[];
  states: Record<number, MessagePipelineState>;
  visibility: StepVisibilityMap;
  onCopyMessage(message: EventStreamMessage): void;
}

export function MessageList({ messages, states, visibility, onCopyMessage }: MessageListProps) {
  return (
    <div className="rounded-lg border">
      <ScrollArea className="max-h-[70vh] overflow-y-auto">
        <div className="divide-y">
          {messages.length === 0 && (
            <div className="text-muted-foreground py-6 text-center text-xs">
              没有可解析的 event-stream 消息
            </div>
          )}
          {messages.map((message, index) => {
            const state = states[index];
            return (
              <div key={message.index} className="space-y-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px] uppercase">
                      #{message.index + 1}
                    </Badge>
                    {message.event ? (
                      <Badge variant="secondary">{message.event}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">(event)</span>
                    )}
                    {message.id && (
                      <span className="text-muted-foreground truncate text-[11px]">
                        id: {message.id}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {state && (
                      <Badge
                        variant={
                          state.status === "error"
                            ? "destructive"
                            : state.status === "success"
                              ? "secondary"
                              : "outline"
                        }
                        className="text-[11px]"
                      >
                        {state.status === "success"
                          ? "完成"
                          : state.status === "error"
                            ? "失败"
                            : state.status === "running"
                              ? "运行中"
                              : "待处理"}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => onCopyMessage(message)}
                      title="复制 message data"
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </div>

                {state?.status === "running" && (
                  <p className="text-muted-foreground text-xs">正在套用转换器…</p>
                )}

                {state?.status === "error" && state.error && (
                  <Alert variant="destructive">
                    <AlertTitle>转换失败</AlertTitle>
                    <AlertDescription className="text-xs">{state.error}</AlertDescription>
                  </Alert>
                )}

                {state?.steps?.length ? (
                  <div className="bg-muted/40 space-y-2 rounded-md border p-2">
                    {state.steps.map((step, stepIndex) => {
                      const hidden =
                        step.instanceId === "raw"
                          ? visibility.raw === false
                          : visibility[step.instanceId] === false;
                      if (hidden) return null;
                      return (
                        <div key={`${message.index}-${step.instanceId}`}>
                          <div className="text-muted-foreground mb-1 flex items-center justify-between text-[11px]">
                            <span>
                              {stepIndex === 0 ? "原始数据" : `${stepIndex}. ${step.name}`}
                            </span>
                            <span>{step.durationMs.toFixed(2)} ms</span>
                          </div>
                          <div
                            className={`overflow-hidden rounded border ${
                              step.success
                                ? "bg-background/80"
                                : "bg-destructive/5 text-destructive border-destructive/40"
                            }`}
                          >
                            {step.error ? (
                              <>
                                <p className="mb-1 text-[11px] font-semibold">{step.error}</p>
                                <StepOutput value={step.value} className="*:p-2" />
                              </>
                            ) : (
                              <StepOutput value={step.value} className="*:p-2" />
                            )}
                          </div>
                          {stepIndex !== state.steps.length - 1 && <Separator className="my-2" />}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
