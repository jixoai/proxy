export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

export function getStatusClass(status: number): string {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "redirect";
  return "error";
}

export function getMethodColor(method: string): string {
  const colors: Record<string, string> = {
    GET: "bg-emerald-500",
    POST: "bg-blue-500",
    PUT: "bg-amber-500",
    DELETE: "bg-red-500",
    PATCH: "bg-purple-500",
  };
  return colors[method] || "bg-gray-500";
}

export function parseMarkdownHeaders(markdown: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = markdown.split("\n");
  let inHeadersSection = false;
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.includes("## 请求头") || line.includes("## 响应头")) {
      inHeadersSection = true;
      continue;
    }

    if (inHeadersSection) {
      if (line.trim() === "```") {
        inCodeBlock = !inCodeBlock;
        continue;
      }

      if (inCodeBlock && line.includes(":")) {
        const colonIndex = line.indexOf(":");
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        if (key && value) {
          headers[key] = value;
        }
      }

      if (!inCodeBlock && line.startsWith("##")) {
        break;
      }
    }
  }

  return headers;
}

export function detectContentType(headers: Record<string, string>, body: string): {
  type: "json" | "html" | "css" | "javascript" | "xml" | "image" | "text";
  language: string;
} {
  const contentType = headers["content-type"]?.toLowerCase() || "";

  if (contentType.includes("json") || (body.trim().startsWith("{") || body.trim().startsWith("["))) {
    return { type: "json", language: "json" };
  }
  if (contentType.includes("html") || body.trim().startsWith("<!DOCTYPE") || body.trim().startsWith("<html")) {
    return { type: "html", language: "html" };
  }
  if (contentType.includes("css")) {
    return { type: "css", language: "css" };
  }
  if (contentType.includes("javascript") || contentType.includes("ecmascript")) {
    return { type: "javascript", language: "javascript" };
  }
  if (contentType.includes("xml") || body.trim().startsWith("<?xml")) {
    return { type: "xml", language: "xml" };
  }
  if (contentType.includes("image")) {
    return { type: "image", language: "text" };
  }

  return { type: "text", language: "text" };
}
