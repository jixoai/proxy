import type { BodyViewerPlugin, PluginContext, Content } from "@/contexts/BodyViewerPlugin";
import type { DecompressRequest, DecompressResponse } from "@/lib/decompress";
import { dataUrlToUint8Array } from "@/lib/data-url";

export interface DecompressPluginOptions {
  /**
   * 是否显示解压统计信息
   * @default true
   */
  showStats?: boolean;
}

/**
 * 将 Uint8Array 转换为 base64
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = "";
  const len = data.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

/**
 * Decompress 插件（工厂函数）
 *
 * 负责检测和解压 gzip/br/deflate 压缩的内容
 * 通过调用服务器端的 /api/decompress API 进行解压
 */
export function decompressPlugin(options: DecompressPluginOptions = {}): BodyViewerPlugin {
  const { showStats = true } = options;

  return {
    name: "decompress",
    enforce: "pre", // 在 viewer 之前执行

    /**
     * Transform 钩子：检测并解压压缩内容
     */
    async transform(content: Content, ctx: PluginContext): Promise<Content | null> {
      // 1. 检查是否有 content-encoding
      const contentEncoding = ctx.headers["content-encoding"];
      if (!contentEncoding) {
        return null; // 没有压缩，不处理
      }

      // 2. 检查内容是否为空
      if (!content.value || content.value.length === 0) {
        return null; // 空内容，不处理
      }

      // 3. 将 Uint8Array 转换为 base64（用于 API 调用）
      const base64Data = uint8ArrayToBase64(content.value);

      if (!base64Data) {
        console.warn("[decompressPlugin] Empty base64 data");
        return null;
      }

      // 4. 调用服务器端 API 解压数据
      try {
        const request: DecompressRequest = {
          data: base64Data,
          encoding: contentEncoding,
          mime: content.mime,
        };

        const response = await fetch("/api/decompress", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const result: DecompressResponse = await response.json();

        if (!result.success || !result.data) {
          console.error("[decompressPlugin] Decompression failed:", result.error);
          return null;
        }

        // 5. 将 data URL 转换为 Uint8Array
        // result.data 是 data URL 格式，使用自定义函数解析（不依赖 fetch API）
        const decompressedData = dataUrlToUint8Array(result.data);
        if (!decompressedData) {
          console.error("[decompressPlugin] Failed to parse decompressed data URL");
          return null;
        }

        // 6. 可选：显示解压统计信息（存储到插件配置中）
        if (showStats && result.size) {
          const { compressed, decompressed, ratio } = result.size;
          ctx.setConfig({
            stats: {
              encoding: contentEncoding,
              compressed,
              decompressed,
              ratio,
            },
          });
        }

        // 7. 返回解压后的数据
        return {
          mime: content.mime,
          value: decompressedData,
        };
      } catch (error) {
        console.error("[decompressPlugin] Decompression failed:", error);
        return null;
      }
    },
  };
}
