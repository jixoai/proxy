import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Type, Binary, Hash, FileCode } from "lucide-react";
import type {
  BodyViewerPlugin,
  PluginContext,
  Content,
} from "@/contexts/BodyViewerPlugin";

/**
 * Uint8Array 解码为 UTF-8
 */
function decodeToUTF8(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8").decode(data);
  } catch (error) {
    return `Failed to decode: ${error}`;
  }
}

/**
 * Uint8Array 转换为 Hex
 */
function toHex(data: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte !== undefined) {
      hex += byte.toString(16).padStart(2, "0") + " ";
      if ((i + 1) % 16 === 0) {
        hex += "\n";
      }
    }
  }
  return hex.trim();
}

/**
 * Uint8Array 转换为 Binary
 */
function toBinary(data: Uint8Array): string {
  let result = "";
  const limit = Math.min(data.length, 512);
  for (let i = 0; i < limit; i++) {
    const byte = data[i];
    if (byte !== undefined) {
      result += byte.toString(2).padStart(8, "0") + " ";
      if ((i + 1) % 8 === 0) {
        result += "\n";
      }
    }
  }
  if (data.length > 512) {
    result += `\n... (truncated, total ${data.length} bytes)`;
  }
  return result.trim();
}

/**
 * Uint8Array 转换为 Base64
 */
function toBase64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

/**
 * Binary 查看器面板
 */
export function BinaryViewerPanel({ data }: { data: Uint8Array }) {
  const utf8Decoded = decodeToUTF8(data);
  const hexDecoded = toHex(data);
  const binaryDecoded = toBinary(data);
  const base64Decoded = toBase64(data);

  return (
    <Tabs defaultValue="utf8" className="w-full">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="utf8">
          <Type className="w-4 h-4 mr-1" />
          UTF-8
        </TabsTrigger>
        <TabsTrigger value="hex">
          <Hash className="w-4 h-4 mr-1" />
          Hex
        </TabsTrigger>
        <TabsTrigger value="binary">
          <Binary className="w-4 h-4 mr-1" />
          Binary
        </TabsTrigger>
        <TabsTrigger value="base64">
          <FileCode className="w-4 h-4 mr-1" />
          Base64
        </TabsTrigger>
      </TabsList>

      <TabsContent
        value="utf8"
        className="bg-muted rounded-lg p-4 max-h-[600px] overflow-auto"
      >
        <pre className="font-mono text-xs whitespace-pre-wrap break-all">
          {utf8Decoded}
        </pre>
      </TabsContent>

      <TabsContent
        value="hex"
        className="bg-muted rounded-lg p-4 max-h-[600px] overflow-auto"
      >
        <pre className="font-mono text-xs whitespace-pre">{hexDecoded}</pre>
      </TabsContent>

      <TabsContent
        value="binary"
        className="bg-muted rounded-lg p-4 max-h-[600px] overflow-auto"
      >
        <pre className="font-mono text-xs whitespace-pre">{binaryDecoded}</pre>
      </TabsContent>

      <TabsContent
        value="base64"
        className="bg-muted rounded-lg p-4 max-h-[600px] overflow-auto"
      >
        <pre className="font-mono text-xs whitespace-pre-wrap break-all">
          {base64Decoded}
        </pre>
      </TabsContent>
    </Tabs>
  );
}

/**
 * Binary 查看器插件（工厂函数）
 *
 * 用于查看二进制/编码数据（Base64, Hex, Binary 格式）
 */
export function binaryViewerPlugin(): BodyViewerPlugin {
  return {
    name: "binary-viewer",

    /**
     * Transform 钩子：注册 Binary 查看器
     * 在 transform 中同步声明 tab、content
     */
    transform(content: Content, ctx: PluginContext) {
      const mime = content.mime;

      // 只在非文本且非图片的情况下注册
      const isText =
        mime.startsWith("text/") ||
        mime === "application/json" ||
        mime === "application/xml";
      const isImage = mime.startsWith("image/");

      if (isText || isImage) {
        return null;
      }

      // 注册 viewer
      ctx.registerViewer({
        tab: (
          <span className="flex items-center gap-1">
            <FileCode className="size-3" />
            Binary
          </span>
        ),
        content: (
          <BinaryViewerPanel key="binary-viewer" data={content.value} />
        ),
      });

      // 不修改 content
      return null;
    },
  };
}
