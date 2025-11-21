import { useCallback, useEffect, useState } from "react";
import type {
  ConverterInstance,
  EventStreamMessage,
  MessagePipelineState,
  PipelineStepResult,
  StepVisibilityMap,
} from "./types";
import {
  ensureString,
  loadCustomModule,
  prepareJson,
  runBuiltInConverter,
} from "./converter-tools";

export function useEventStreamPipeline(
  messages: EventStreamMessage[],
  converters: ConverterInstance[],
) {
  const [messageStates, setMessageStates] = useState<
    Record<number, MessagePipelineState>
  >({});

  const executePipeline = useCallback(
    async (message: EventStreamMessage) => {
      let current: unknown = message.data;
      const steps: PipelineStepResult[] = [
        {
          instanceId: "raw",
          name: "原始",
          durationMs: 0,
          success: true,
          value: current,
        },
      ];

      const textForJson = ensureString(message.data) ?? "";
      const preparedJson = prepareJson(textForJson);

      for (let i = 0; i < converters.length; i++) {
        const converter = converters[i]!;
        const stepName = converter.kind === "builtin" ? converter.converterId : converter.name;
        const start = performance.now();
        try {
          let next: unknown = current;
          if (converter.kind === "builtin") {
            next = await runBuiltInConverter(converter.converterId, current);
          } else {
            const transformer = await loadCustomModule(converter);
            if (!transformer) throw new Error("Missing converter implementation");
            const text = ensureString(current) ?? "";
            next = await transformer(text, preparedJson, {
              message,
              stepIndex: i,
            });
          }
          steps.push({
            instanceId: converter.instanceId,
            name: stepName,
            durationMs: performance.now() - start,
            success: true,
            value: next,
          });
          current = next;
        } catch (error) {
          steps.push({
            instanceId: converter.instanceId,
            name: stepName,
            durationMs: performance.now() - start,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            value: current,
          });
          const pipelineError = new Error(
            (error as Error)?.message || "转换失败",
          );
          (pipelineError as any).steps = steps.slice();
          throw pipelineError;
        }
      }

      return { steps, output: current };
    },
    [converters],
  );

  useEffect(() => {
    let cancelled = false;
    messages.forEach((message, index) => {
      setMessageStates((prev) => ({
        ...prev,
        [index]: { status: "running", steps: [] },
      }));
      executePipeline(message)
        .then(({ steps, output }) => {
          if (cancelled) return;
          setMessageStates((prev) => ({
            ...prev,
            [index]: { status: "success", steps, output },
          }));
        })
        .catch((error) => {
          if (cancelled) return;
          const failedSteps =
            error && typeof error === "object" && "steps" in error
              ? ((error as any).steps as PipelineStepResult[])
              : [];
          setMessageStates((prev) => ({
            ...prev,
            [index]: {
              status: "error",
              steps: failedSteps,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [messages, executePipeline]);

  return { messageStates };
}

export function normalizeVisibility(
  converters: ConverterInstance[],
  previous: StepVisibilityMap,
): StepVisibilityMap {
  const allowed = new Set(["raw", ...converters.map((c) => c.instanceId)]);
  const next: StepVisibilityMap = {};
  allowed.forEach((id) => {
    next[id] = previous[id] ?? true;
  });
  return next;
}
