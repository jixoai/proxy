import type { RequestData } from "@/components/ProxyViewerContext";

/**
 * 生成浏览器环境的 fetch 代码
 * @param request 请求数据
 * @param mode "via-proxy" 通过代理访问（使用代理 URL）；"to-target" 直接访问目标（使用目标 URL）
 */
export function generateFetchCode(
  request: RequestData,
  mode: "via-proxy" | "to-target" = "via-proxy",
): string {
  const { method, url } = request.metadata.request;
  // via-proxy: 使用代理 URL (http://localhost:10001)
  // to-target: 使用目标 URL (https://api.deepseek.com)
  const targetUrl =
    mode === "to-target" && request.metadata.targetUrl ? request.metadata.targetUrl : url;
  const useHeaders =
    mode === "to-target" && request.metadata.forwardedHeaders
      ? request.metadata.forwardedHeaders
      : request.requestContent
        ? parseHeadersFromMarkdown(request.requestContent)
        : {};

  // 移除一些不需要的 headers
  const cleanHeaders = { ...useHeaders };
  delete cleanHeaders["host"];
  delete cleanHeaders["connection"];
  delete cleanHeaders["proxy-connection"];
  delete cleanHeaders["content-length"];

  const hasHeaders = Object.keys(cleanHeaders).length > 0;
  const hasBody = request.requestBody && method !== "GET" && method !== "HEAD";

  let code = `fetch("${targetUrl}"`;

  if (hasHeaders || hasBody || method !== "GET") {
    code += ", {\n";

    if (method !== "GET") {
      code += `  method: "${method}",\n`;
    }

    if (hasHeaders) {
      code += "  headers: {\n";
      for (const [key, value] of Object.entries(cleanHeaders)) {
        code += `    "${key}": "${escapeString(value)}",\n`;
      }
      code += "  },\n";
    }

    if (hasBody) {
      const bodyContent = request.requestBody || "";
      const contentType = cleanHeaders["content-type"] || "";

      if (contentType.includes("application/json")) {
        // 尝试格式化 JSON
        try {
          const jsonObj = JSON.parse(bodyContent);
          code += `  body: JSON.stringify(${JSON.stringify(jsonObj, null, 2).split("\n").join("\n  ")}),\n`;
        } catch {
          code += `  body: ${JSON.stringify(bodyContent)},\n`;
        }
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        code += `  body: ${JSON.stringify(bodyContent)},\n`;
      } else {
        code += `  body: ${JSON.stringify(bodyContent)},\n`;
      }
    }

    code += "}";
  }

  code += ")";

  return code;
}

/**
 * 生成 Node.js 环境的 fetch 代码
 * @param request 请求数据
 * @param mode "via-proxy" 通过代理访问（使用代理 URL）；"to-target" 直接访问目标（使用目标 URL）
 */
export function generateNodeFetchCode(
  request: RequestData,
  mode: "via-proxy" | "to-target" = "via-proxy",
): string {
  const { method, url } = request.metadata.request;
  // via-proxy: 使用代理 URL (http://localhost:10001)
  // to-target: 使用目标 URL (https://api.deepseek.com)
  const targetUrl =
    mode === "to-target" && request.metadata.targetUrl ? request.metadata.targetUrl : url;
  const useHeaders =
    mode === "to-target" && request.metadata.forwardedHeaders
      ? request.metadata.forwardedHeaders
      : request.requestContent
        ? parseHeadersFromMarkdown(request.requestContent)
        : {};

  // 移除一些不需要的 headers
  const cleanHeaders = { ...useHeaders };
  delete cleanHeaders["host"];
  delete cleanHeaders["connection"];
  delete cleanHeaders["proxy-connection"];
  delete cleanHeaders["content-length"];

  const hasHeaders = Object.keys(cleanHeaders).length > 0;
  const hasBody = request.requestBody && method !== "GET" && method !== "HEAD";

  let code = "";

  // 如果有 body，先声明 body 变量
  if (hasBody) {
    const bodyContent = request.requestBody || "";
    const contentType = cleanHeaders["content-type"] || "";

    if (contentType.includes("application/json")) {
      try {
        const jsonObj = JSON.parse(bodyContent);
        code += `const body = JSON.stringify(${JSON.stringify(jsonObj, null, 2)});\n\n`;
      } catch {
        code += `const body = ${JSON.stringify(bodyContent)};\n\n`;
      }
    } else {
      code += `const body = ${JSON.stringify(bodyContent)};\n\n`;
    }
  }

  code += `const response = await fetch("${targetUrl}"`;

  if (hasHeaders || hasBody || method !== "GET") {
    code += ", {\n";

    if (method !== "GET") {
      code += `  method: "${method}",\n`;
    }

    if (hasHeaders) {
      code += "  headers: {\n";
      for (const [key, value] of Object.entries(cleanHeaders)) {
        code += `    "${key}": "${escapeString(value)}",\n`;
      }
      code += "  },\n";
    }

    if (hasBody) {
      code += "  body,\n";
    }

    code += "}";
  }

  code += ");\n\n";
  code += "const data = await response.json();\n";
  code += "console.log(data);";

  return code;
}

/**
 * 从 markdown 格式的 requestContent 中解析 headers
 */
function parseHeadersFromMarkdown(content: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const headerMatch = content.match(/## 请求头\n\n```\n([\s\S]*?)\n```/);

  if (headerMatch && headerMatch[1]) {
    const headerLines = headerMatch[1].split("\n");
    for (const line of headerLines) {
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim().toLowerCase();
        const value = line.substring(colonIndex + 1).trim();
        headers[key] = value;
      }
    }
  }

  return headers;
}

/**
 * 转义字符串中的特殊字符
 */
function escapeString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * 复制文本到剪贴板
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Failed to copy to clipboard:", error);

    // Fallback: 使用旧的 document.execCommand 方法
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      document.body.appendChild(textArea);
      textArea.select();
      const success = document.execCommand("copy");
      document.body.removeChild(textArea);
      return success;
    } catch (fallbackError) {
      console.error("Fallback copy method also failed:", fallbackError);
      return false;
    }
  }
}
