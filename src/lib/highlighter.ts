import highlightWorkerService from "@/services/highlightWorkerService";

export interface HighlightValue {
  toString(): string;
  toHTML(): Promise<string>;
}

type TemplateValue =
  | HighlightValue
  | string
  | number
  | boolean
  | null
  | undefined;
type HighlightPart = string | HighlightValue;

function isTemplateValueHighlight(
  value: TemplateValue,
): value is HighlightValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as HighlightValue).toString === "function" &&
    typeof (value as HighlightValue).toHTML === "function"
  );
}

export function isHighlightValue(value: unknown): value is HighlightValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as HighlightValue).toString === "function" &&
    typeof (value as HighlightValue).toHTML === "function"
  );
}

function buildParts(
  strings: TemplateStringsArray,
  values: TemplateValue[],
): HighlightPart[] {
  const parts: HighlightPart[] = [];
  strings.forEach((segment, index) => {
    if (segment) parts.push(segment);
    if (index < values.length) {
      const value = values[index];
      if (isTemplateValueHighlight(value)) {
        parts.push(value);
      } else if (value === null || value === undefined) {
        // ignore
      } else {
        parts.push(String(value));
      }
    }
  });
  return parts;
}

function flatten(parts: HighlightPart[]) {
  return parts.map((p) => (typeof p === "string" ? p : p.toString())).join("");
}

export function createHighlightTag(
  language: string,
  options: { theme?: string } = {},
) {
  const theme = options.theme ?? "github-dark-default";
  return (
    strings: TemplateStringsArray,
    ...values: TemplateValue[]
  ): HighlightValue => {
    const parts = buildParts(strings, values);
    const plain = flatten(parts);
    return {
      toString() {
        return plain;
      },
      async toHTML() {
        const response = await highlightWorkerService.highlight(
          plain,
          language,
          theme,
        );
        if (response.success) return response.html;
        throw new Error(response.error || "Highlight failed");
      },
    };
  };
}

export function createTextTag(): (
  strings: TemplateStringsArray,
  ...values: TemplateValue[]
) => HighlightValue {
  return (strings, ...values) => {
    const parts = buildParts(strings, values);
    return {
      toString() {
        return flatten(parts);
      },
      async toHTML() {
        let html = "";
        for (const part of parts) {
          if (typeof part === "string") {
            html += part;
          } else {
            html += await part.toHTML();
          }
        }
        return html;
      },
    };
  };
}

export const TEXT = createTextTag();
export const RAW = TEXT;
const _JSON = globalThis.JSON;
export const JSON = Object.assign(createHighlightTag("json"), {
  stringify: _JSON.stringify.bind(_JSON),
  parse: _JSON.parse.bind(_JSON),
});
export const HTML = createHighlightTag("html");
export const TYPESCRIPT = createHighlightTag("typescript");
export const TS = TYPESCRIPT;
export const JAVASCRIPT = createHighlightTag("javascript");
export const JS = JAVASCRIPT;
export const PYTHON = createHighlightTag("python");
export const PY = PYTHON;
export const SQL = createHighlightTag("sql");

export function html(
  strings: TemplateStringsArray,
  ...values: TemplateValue[]
) {
  const parts = buildParts(strings, values);
  return (text: string): HighlightValue => {
    return {
      toString() {
        return text;
      },
      async toHTML() {
        let html = "";
        for (const part of parts) {
          if (typeof part === "string") {
            html += part;
          } else {
            html += await part.toHTML();
          }
        }
        return html;
      },
    };
  };
}

export const Highlight = {
  createHighlightTag,
  createTextTag,
  TEXT,
  RAW,
  JSON,
  HTML,
  TS,
  TYPESCRIPT,
  JS,
  JAVASCRIPT,
  PY,
  PYTHON,
  SQL,
  html,
};
