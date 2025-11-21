import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  FileText,
  Copy,
  Wand2,
  MoreHorizontal,
  ChevronsUpDown,
  FileJson2,
} from "lucide-react";
import {
  BiText,
  BiCodeAlt,
  BiLogoJavascript,
  BiLogoTypescript,
  BiLogoHtml5,
  BiLogoCss3,
  BiLogoPython,
  BiLogoJava,
  BiCodeBlock,
  BiLogoMarkdown,
  BiSolidFileJson,
  BiCode,
  BiCodeCurly,
} from "react-icons/bi";
import { DiRuby } from "react-icons/di";
import { SiYaml } from "react-icons/si";
import {
  BsFiletypeJson,
  BsFiletypeJsx,
  BsFiletypeSh,
  BsFiletypeSql,
} from "react-icons/bs";
import {
  TbBrandKotlin,
  TbBrandCarbon,
  TbBrandCpp,
  TbBrandCSharp,
  TbBrandPhp,
  TbBrandRust,
  TbBrandGolang,
  TbBrandSwift,
  TbBrandPowershell,
  TbFileTypeJsx,
  TbFileTypeTsx,
  TbJson,
  TbFileTypeXml,
  TbToml,
} from "react-icons/tb";

import { Highlighter } from "@/components/Highlighter";
import { detectContentType } from "@/components/utils";
import type {
  BodyViewerPlugin,
  PluginContext,
  Content,
} from "@/contexts/BodyViewerPlugin";

const SUPPORTED_LANGUAGES = [
  "text",
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "json",
  "html",
  "css",
  "python",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "go",
  "rust",
  "kotlin",
  "swift",
  "sql",
  "markdown",
  "yaml",
  "xml",
  "bash",
  "shell",
  "powershell",
] as const;

const LANGUAGE_EXTENSION_MAP: Record<string, string> = {
  text: "txt",
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  json: "json",
  html: "html",
  css: "css",
  python: "py",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  cs: "cs",
  php: "php",
  ruby: "rb",
  go: "go",
  rust: "rs",
  kotlin: "kt",
  swift: "swift",
  sql: "sql",
  markdown: "md",
  md: "md",
  yaml: "yaml",
  yml: "yml",
  xml: "xml",
  bash: "sh",
  shell: "sh",
  powershell: "ps1",
  toml: "toml",
};

function languageToExtension(language: string) {
  const ext = LANGUAGE_EXTENSION_MAP[language.toLowerCase()];
  return ext || language.toLowerCase() || "txt";
}

function languageToFilename(language: string) {
  return `file.${languageToExtension(language)}`;
}

/**
 * 根据语言类型返回对应的图标
 */
function getLanguageIcon(language: string) {
  const iconProps = { className: "size-4" };

  switch (language.toLowerCase()) {
    case "text":
      return <BiText {...iconProps} />;
    case "javascript":
    case "js":
      return <BiLogoJavascript {...iconProps} />;
    case "typescript":
    case "ts":
      return <BiLogoTypescript {...iconProps} />;
    case "jsx":
      return <TbFileTypeJsx {...iconProps} />;
    case "tsx":
      return <TbFileTypeTsx {...iconProps} />;
    case "html":
      return <BiLogoHtml5 {...iconProps} />;
    case "css":
      return <BiLogoCss3 {...iconProps} />;
    case "python":
    case "py":
      return <BiLogoPython {...iconProps} />;
    case "java":
      return <BiLogoJava {...iconProps} />;
    case "markdown":
    case "md":
      return <BiLogoMarkdown {...iconProps} />;
    case "json":
      return <FileJson2 {...iconProps} />;
    case "xml":
      return <TbFileTypeXml {...iconProps} />;
    case "toml":
      return <TbToml {...iconProps} />;
    case "yaml":
      return <SiYaml {...iconProps} />;
    case "bash":
      return <BiCodeBlock {...iconProps} />;
    case "shell":
      return <BsFiletypeSh {...iconProps} />;
    case "powershell":
      return <TbBrandPowershell {...iconProps} />;
    case "c":
      return <TbBrandCarbon {...iconProps} />;
    case "cpp":
      return <TbBrandCpp {...iconProps} />;
    case "csharp":
      return <TbBrandCSharp {...iconProps} />;
    case "kotlin":
      return <TbBrandKotlin {...iconProps} />;
    case "php":
      return <TbBrandPhp {...iconProps} />;
    case "ruby":
      return <DiRuby {...iconProps} />;
    case "rust":
      return <TbBrandRust {...iconProps} />;
    case "go":
      return <TbBrandGolang {...iconProps} />;
    case "swift":
      return <TbBrandSwift {...iconProps} />;
    case "sql":
      return <BsFiletypeSql {...iconProps} />;
    default:
      return <BiCode {...iconProps} />;
  }
}

function isTextMime(mime: string) {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  );
}

/**
 * 文本/代码查看器面板（使用 Highlighter）
 */
export function TextViewerPanel({
  code: initialCode,
  mimeLanguage,
  ctx,
  enableActions = true,
}: {
  code: string;
  mimeLanguage: string;
  ctx: PluginContext;
  enableActions?: boolean;
}) {
  const [code, setCode] = useState(initialCode);
  // 语法模式：'text' | 'mime' | 自定义语言
  const [syntaxMode, setSyntaxMode] = useState<"text" | "mime" | string>(
    mimeLanguage === "text" ? "text" : "mime",
  );
  const [customLanguage, setCustomLanguage] = useState<string>("");
  const [comboboxOpen, setComboboxOpen] = useState(false);
  const [formattedCode, setFormattedCode] = useState<string | null>(null);
  const [isFormatEnabled, setIsFormatEnabled] = useState(false);
  const [isFormatting, setIsFormatting] = useState(false);

  const originalCodeRef = useRef(initialCode);
  const formatRequestIdRef = useRef(0);
  const lastFormattedLanguageRef = useRef<string | null>(null);

  // 计算当前使用的语言
  const currentLanguage =
    syntaxMode === "text"
      ? "text"
      : syntaxMode === "mime"
        ? mimeLanguage
        : customLanguage;

  // 同步外部传入的新文本
  useEffect(() => {
    formatRequestIdRef.current += 1; // 使旧的格式化请求失效
    originalCodeRef.current = initialCode;
    setCode(initialCode);
    setFormattedCode(null);
    setIsFormatEnabled(false);
    setIsFormatting(false);
    lastFormattedLanguageRef.current = null;
  }, [initialCode]);

  // 根据当前语言执行格式化
  const runFormat = useCallback(
    async (language: string) => {
      const requestId = ++formatRequestIdRef.current;
      setIsFormatting(true);

      try {
        const response = await fetch("/api/format", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: originalCodeRef.current,
            filename: languageToFilename(language),
          }),
        });

        const result = await response.json();

        if (requestId !== formatRequestIdRef.current) {
          return; // 已被新的请求取代
        }

        if (result.success && result.formatted) {
          setFormattedCode(result.formatted);
          setCode(result.formatted);
          lastFormattedLanguageRef.current = language;
        } else {
          ctx.showTip(
            {
              type: "error",
              content: `Format failed: ${result.error || "unknown error"}`,
            },
            4000,
          );
          setIsFormatEnabled(false);
          setFormattedCode(null);
          setCode(originalCodeRef.current);
          lastFormattedLanguageRef.current = null;
        }
      } catch (error) {
        if (requestId !== formatRequestIdRef.current) {
          return;
        }
        ctx.showTip(
          {
            type: "error",
            content: `Format error: ${error instanceof Error ? error.message : String(error)}`,
          },
          4000,
        );
        setIsFormatEnabled(false);
        setFormattedCode(null);
        setCode(originalCodeRef.current);
        lastFormattedLanguageRef.current = null;
      } finally {
        if (requestId === formatRequestIdRef.current) {
          setIsFormatting(false);
        }
      }
    },
    [ctx],
  );

  const toggleFormat = useCallback(() => {
    setIsFormatEnabled((prev) => {
      if (prev) {
        formatRequestIdRef.current += 1; // 使进行中的请求失效
        setFormattedCode(null);
        setCode(originalCodeRef.current);
        setIsFormatting(false);
        lastFormattedLanguageRef.current = null;
        return false;
      }
      return true;
    });
  }, []);

  // 语言变化或开启格式化时重新格式化
  useEffect(() => {
    if (!isFormatEnabled) {
      setCode(originalCodeRef.current);
      return;
    }
    if (
      lastFormattedLanguageRef.current === currentLanguage &&
      formattedCode
    ) {
      setCode(formattedCode);
      return;
    }
    runFormat(currentLanguage);
  }, [isFormatEnabled, currentLanguage, formattedCode, runFormat]);

  const formatLabel = languageToExtension(currentLanguage).toUpperCase();

  // 动态注册 Syntax 和 Format actions
  useEffect(() => {
    if (!enableActions) {
      return;
    }
    return ctx.registerActions([
      {
        id: "text/syntax",
        render: () => (
          <ButtonGroup>
            {/* Text 按钮 */}
            <Button
              variant={syntaxMode === "text" ? "default" : "outline"}
              size="sm"
              onClick={() => setSyntaxMode("text")}
            >
              {syntaxMode === "text" ? (
                <>
                  {getLanguageIcon("text")}
                  <span className="ml-1">Text</span>
                </>
              ) : (
                getLanguageIcon("text")
              )}
            </Button>

            {/* MIME 按钮 */}
            {mimeLanguage !== "text" && (
              <Button
                variant={syntaxMode === "mime" ? "default" : "outline"}
                size="sm"
                onClick={() => setSyntaxMode("mime")}
              >
                {syntaxMode === "mime" ? (
                  <>
                    {getLanguageIcon(mimeLanguage)}
                    <span className="ml-1 capitalize">{mimeLanguage}</span>
                  </>
                ) : (
                  getLanguageIcon(mimeLanguage)
                )}
              </Button>
            )}

            {/* Custom Combobox 按钮 */}
            <Popover open={comboboxOpen} onOpenChange={setComboboxOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant={
                    syntaxMode !== "text" && syntaxMode !== "mime"
                      ? "default"
                      : "outline"
                  }
                  size="sm"
                  role="combobox"
                  aria-expanded={comboboxOpen}
                >
                  {syntaxMode !== "text" && syntaxMode !== "mime" ? (
                    <>
                      {getLanguageIcon(customLanguage)}
                      <span className="ml-1 capitalize">{customLanguage}</span>
                      <ChevronsUpDown className="ml-1 size-4" />
                    </>
                  ) : (
                    <MoreHorizontal className="size-4" />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[200px] p-0">
                <Command>
                  <CommandInput placeholder="Search language..." />
                  <CommandList>
                    <CommandEmpty>No language found.</CommandEmpty>
                    <CommandGroup>
                      {SUPPORTED_LANGUAGES.filter(
                        (lang) => lang !== "text",
                      ).map((lang) => (
                        <CommandItem
                          key={lang}
                          value={lang}
                          onSelect={(value) => {
                            setCustomLanguage(value);
                            setSyntaxMode(value);
                            setComboboxOpen(false);
                          }}
                        >
                          {getLanguageIcon(lang)}
                          <span className="ml-2 capitalize">{lang}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </ButtonGroup>
        ),
      },
      {
        id: "text/format",
        render: () => (
          <Button
            variant={isFormatEnabled ? "default" : "outline"}
            size="sm"
            onClick={toggleFormat}
            disabled={isFormatting}
          >
            <Wand2 className={`size-4 ${isFormatting ? "animate-spin" : ""}`} />
            <span className="ml-1">
              {isFormatEnabled ? "Formatting" : "Format"} ({formatLabel})
            </span>
          </Button>
        ),
      },
      {
        id: "text/copy",
        render: () => (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                ctx.showTip(
                  {
                    type: "success",
                    content: "Copied to clipboard!",
                  },
                  3000,
                );
              } catch (error) {
                ctx.showTip(
                  {
                    type: "error",
                    content: `Failed to copy: ${error}`,
                  },
                  3000,
                );
              }
            }}
          >
            <Copy className="size-4" />
            <span className="ml-1">
              {isFormatEnabled ? "Copy formatted" : "Copy"}
            </span>
          </Button>
        ),
      },
    ]);
  }, [
    ctx,
    syntaxMode,
    mimeLanguage,
    customLanguage,
    comboboxOpen,
    code,
    isFormatEnabled,
    isFormatting,
    formatLabel,
    toggleFormat,
    enableActions,
  ]);

  return (
    <div className="rounded-lg overflow-hidden border border-border">
      <div className="max-h-[600px] overflow-auto text-xs">
        <Highlighter
          code={code}
          language={currentLanguage}
          theme="github-dark-default"
        />
      </div>
    </div>
  );
}

/**
 * 文本/代码查看器插件（工厂函数）
 */
export function textViewerPlugin(): BodyViewerPlugin {
  return {
    name: "text-viewer",

    /**
     * Transform 钩子：注册文本/代码查看器
     * 在 transform 中静态声明 tab、content、actions
     */
    transform(content: Content, ctx: PluginContext) {
      // 检查是否是文本类型
      const isText = isTextMime(content.mime);
      if (!isText) {
        return null;
      }

      // 将 Uint8Array 转换为字符串
      const decoder = new TextDecoder("utf-8");
      const textValue = decoder.decode(content.value);

      // 检测内容类型和语言
      const { language } = detectContentType(ctx.headers, textValue);

      // 注册 viewer（静态声明）
      ctx.registerViewer({
        tab: (
          <span className="flex items-center gap-1">
            <FileText className="size-3" />
            Text
          </span>
        ),
        content: (
          <TextViewerPanel
            key="text-viewer"
            code={textValue}
            mimeLanguage={language}
            ctx={ctx}
          />
        ),
      });

      // 不修改 content
      return null;
    },
  };
}
