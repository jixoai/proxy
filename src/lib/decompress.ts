import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { bufferToDataUrl } from "./data-url";

export interface DecompressRequest {
  data: string; // Base64 编码的压缩数据
  encoding: string; // content-encoding 值: gzip/br/deflate
  mime?: string | null; // 原始 Content-Type (用于生成正确的 data URL)
}

export interface DecompressResponse {
  success: boolean;
  data?: string; // 解压后的数据（始终是 data URL 格式）
  size?: {
    compressed: number;
    decompressed: number;
    ratio: string; // 压缩率（百分比）
  };
  error?: string;
}

/**
 * 解压数据
 * @param request 解压请求
 * @returns 解压结果（始终返回 data URL 格式）
 */
export async function decompressData(request: DecompressRequest): Promise<DecompressResponse> {
  const { data, encoding, mime } = request;

  try {
    // 1. Base64 解码
    const compressedBuffer = Buffer.from(data, "base64");

    // 2. 根据编码类型解压
    let decompressedBuffer: Buffer;

    switch (encoding.toLowerCase().trim()) {
      case "gzip":
      case "x-gzip":
        decompressedBuffer = gunzipSync(compressedBuffer);
        break;

      case "br":
        decompressedBuffer = brotliDecompressSync(compressedBuffer);
        break;

      case "deflate":
        decompressedBuffer = inflateSync(compressedBuffer);
        break;

      default:
        return {
          success: false,
          error: `Unsupported encoding: ${encoding}`,
        };
    }

    // 3. 提取 MIME 类型（去除参数，如 charset）
    const mimeType = mime?.split(";")[0]?.trim() || "application/octet-stream";

    // 4. 始终返回 data URL 格式
    const dataUrl = bufferToDataUrl(decompressedBuffer, mimeType);

    // 5. 返回结果
    return {
      success: true,
      data: dataUrl,
      size: {
        compressed: compressedBuffer.length,
        decompressed: decompressedBuffer.length,
        ratio: `${((1 - compressedBuffer.length / decompressedBuffer.length) * 100).toFixed(1)}%`,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
