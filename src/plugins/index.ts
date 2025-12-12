/**
 * BodyViewer 插件集合
 * 统一导出所有插件，方便使用
 */

export { decompressPlugin, type DecompressPluginOptions } from "./decompressPlugin";
export { textViewerPlugin } from "./textViewerPlugin";
export { imageViewerPlugin } from "./imageViewerPlugin";
export { binaryViewerPlugin } from "./binaryViewerPlugin";
export { eventStreamViewerPlugin } from "./event-stream/viewer";

import { decompressPlugin } from "./decompressPlugin";
import { textViewerPlugin } from "./textViewerPlugin";
import { imageViewerPlugin } from "./imageViewerPlugin";
import { binaryViewerPlugin } from "./binaryViewerPlugin";
import { eventStreamViewerPlugin } from "./event-stream/viewer";
import type { BodyViewerPlugin } from "@/contexts/BodyViewerPlugin";

/**
 * 创建默认插件列表
 * 包含所有内置插件
 */
export function createDefaultPlugins(): BodyViewerPlugin[] {
  return [
    decompressPlugin(), // enforce='pre' (在 viewer 之前执行，处理压缩)
    imageViewerPlugin(),
    binaryViewerPlugin(),
    eventStreamViewerPlugin(),
    textViewerPlugin(), // 合并了 text 和 code viewer
  ];
}
