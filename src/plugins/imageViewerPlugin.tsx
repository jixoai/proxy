import { Image } from "lucide-react";
import type {
  BodyViewerPlugin,
  PluginContext,
  Content,
} from "@/contexts/BodyViewerPlugin";

/**
 * 图片查看器面板（纯展示组件）
 */
function ImageViewerPanel({ source, mime }: { source: string; mime: string }) {
  return (
    <div
      className="flex justify-center p-4 rounded"
      style={{
        backgroundImage: `
          linear-gradient(45deg, #e5e7eb 25%, transparent 25%),
          linear-gradient(-45deg, #e5e7eb 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #e5e7eb 75%),
          linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)
        `,
        backgroundSize: "20px 20px",
        backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
      }}
    >
      <img
        src={source}
        alt={`Response preview (${mime})`}
        className="max-w-full max-h-[600px] object-contain border rounded shadow-lg"
      />
    </div>
  );
}

/**
 * 图片查看器插件（工厂函数）
 */
export function imageViewerPlugin(): BodyViewerPlugin {
  return {
    name: "image-viewer",

    /**
     * Transform 钩子：注册图片查看器
     * 在 transform 中同步声明 tab、content
     */
    transform(content: Content, ctx: PluginContext) {
      // 检查是否是图片类型
      const isImage = content.mime.toLowerCase().startsWith("image/");

      if (!isImage) {
        return null;
      }

      // 将 Uint8Array 转换为 blob URL
      const blob = new Blob([new Uint8Array(content.value)], {
        type: content.mime,
      });
      const imageUrl = URL.createObjectURL(blob);

      // 注册 viewer
      ctx.registerViewer({
        tab: (
          <span className="flex items-center gap-1">
            <Image className="size-3" />
            Image
          </span>
        ),
        content: (
          <ImageViewerPanel
            key="image-viewer"
            source={imageUrl}
            mime={content.mime}
          />
        ),
      });

      // 不修改 content
      return null;
    },
  };
}
