import type { HighlightValue } from "@/lib/highlighter";

export interface EventStreamMessage {
  index: number;
  id?: string;
  event?: string;
  retry?: number;
  data: string;
  raw: string;
}

export type BuiltInConverterId = "auto" | "base64" | "json";

export type ConverterInstance =
  | {
      instanceId: string;
      kind: "builtin";
      converterId: BuiltInConverterId;
    }
  | {
      instanceId: string;
      kind: "custom-expression";
      name: string;
      expression: string;
    }
  | {
      instanceId: string;
      kind: "custom-function";
      name: string;
      source: string;
    };

export interface PipelineStepResult {
  instanceId: string;
  name: string;
  durationMs: number;
  success: boolean;
  error?: string;
  value: unknown;
}

export interface MessagePipelineState {
  status: "idle" | "running" | "success" | "error";
  steps: PipelineStepResult[];
  output?: unknown;
  error?: string;
}

export interface PersistedConfig {
  converters: ConverterInstance[];
  visibility?: StepVisibilityMap;
}

export interface ConverterEditorState {
  mode: "expression" | "function";
  name: string;
  code: string;
  targetId?: string;
}

export type StepVisibilityMap = Record<string, boolean>;

export interface HighlightableValue extends HighlightValue {}
