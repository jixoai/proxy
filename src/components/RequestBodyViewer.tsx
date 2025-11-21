import { useState, useEffect } from "react";
import { BodyViewer } from "@/components/BodyViewer";
import { dataUrlToUint8Array } from "@/lib/data-url";

interface RequestBodyViewerProps {
  body: string;
  headers: Record<string, string>;
}

/**
 * Request Body 查看器
 * 将 data URL 格式的 body 转换为 Uint8Array
 */
export function RequestBodyViewer({ body, headers }: RequestBodyViewerProps) {
  const [bodyUint8Array, setBodyUint8Array] = useState<Uint8Array>(
    new Uint8Array(0),
  );

  // 将 data URL 转换为 Uint8Array
  useEffect(() => {
    try {
      // 检查 body 是否为空或无效
      if (!body || !body.startsWith("data:")) {
        setBodyUint8Array(new Uint8Array(0));
        return;
      }

      // 使用自定义函数解析 data URL（不依赖 fetch API）
      const bytes = dataUrlToUint8Array(body);
      if (bytes) {
        setBodyUint8Array(bytes);
      } else {
        console.error("[RequestBodyViewer] Failed to parse data URL");
        setBodyUint8Array(new Uint8Array(0));
      }
    } catch (error) {
      console.error("[RequestBodyViewer] Failed to convert data URL:", error);
      setBodyUint8Array(new Uint8Array(0));
    }
  }, [body]);

  return (
    <BodyViewer
      body={bodyUint8Array}
      headers={headers}
      title="Request Body"
      emptyMessage="No Request Body"
    />
  );
}
