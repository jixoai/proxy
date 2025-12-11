#!/usr/bin/env node
/**
 * Droid-CLI to Claude-Code-CLI request rewrite hook
 *
 * 通过 JSON-RPC 2.0 协议接收请求，将 droid-cli 的请求格式转换为 claude-code-cli 兼容的格式
 * 主要工作：在用户消息中追加系统提示，使 claude-code 能够处理 droid 的 tools
 */

const readline = require("readline");
const fs = require("fs");
const path = require("path");

// 日志目录
const LOG_DIR = path.join(__dirname, "hook-logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 请求计数器
let requestCounter = 0;

/**
 * 记录日志到文件
 */
function logToFile(prefix, data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}_${requestCounter}_${prefix}.json`;
  const filepath = path.join(LOG_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.error(`[droid-to-claude] Logged to: ${filename}`);
}

// 导入参考的 claude-code 请求格式
const claudeCodeReqRef = {
  // model: "claude-opus-4-5-20251101",
  // messages: [],
  system: [
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      // cache_control: { type: "ephemeral" },
    },
  ],
  // tools: [],
  // max_tokens: 32000,
  metadata: {
    user_id:
      "user_8affcbe039c1380bd8de140015ef63dd4936d02ecd7d5a0f78af6ed95967c5c0_account__session_dffce60e-e7a0-4bc3-b847-4e25f13d3c66",
  },
  // stream: true,
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

/**
 * 发送 JSON-RPC 响应
 */
function sendResponse(id, result, error = null) {
  const response = {
    jsonrpc: "2.0",
    id,
    ...(error ? { error } : { result }),
  };
  console.log(JSON.stringify(response));
}

/**
 * 将 droid 的 tools 转换为提示词描述
 */
function toolsToPrompt(tools) {
  if (!tools || tools.length === 0) return "";

  const toolDescriptions = tools
    .map((tool) => {
      const params = tool.input_schema?.properties
        ? Object.entries(tool.input_schema.properties)
            .map(([name, schema]) => `  - ${name}: ${schema.description || ""}`)
            .join("\n")
        : "";
      return `### ${tool.name}\n${tool.description || ""}\n${params ? `Parameters:\n${params}` : ""}`;
    })
    .join("\n\n");

  return `\n\n<available_tools>\nThe following tools are available for you to use:\n\n${toolDescriptions}\n</available_tools>`;
}

/**
 * 检测是否是 droid 请求
 * 通过检查 system 字段中是否包含 "Droid" 或 "Factory" 关键词
 */
function isDroidRequest(requestBody) {
  if (!requestBody.system) return false;

  const systemText = Array.isArray(requestBody.system)
    ? requestBody.system.map((s) => s.text || "").join(" ")
    : String(requestBody.system);

  return (
    systemText.includes("Droid") ||
    systemText.includes("Factory") ||
    systemText.includes("factory-droid")
  );
}

/**
 * 提取 system 字段的文本内容
 */
function extractSystemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((s) => s.text || "").join("\n\n");
  }
  return "";
}

/**
 * 将字符串内容规范为 content 数组
 */
function normalizeContentArray(message) {
  if (!message) return;
  if (Array.isArray(message.content)) return;
  if (typeof message.content === "string") {
    message.content = [{ type: "text", text: message.content }];
    return;
  }
  message.content = [];
}

function replaceSystemReminderSection(originalText, newReminderText) {
  if (typeof originalText !== "string" || typeof newReminderText !== "string")
    return null;

  const startTag = "<system-reminder>";
  const endTag = "</system-reminder>";
  const start = originalText.indexOf(startTag);
  const end = originalText.lastIndexOf(endTag);
  if (start === -1 || end === -1 || end <= start) return null;

  const before = originalText.slice(0, start);
  const after = originalText.slice(end + endTag.length);
  return `${before}${newReminderText}${after}`;
}

/**
 * 合并连续的 user messages 中重复的 <system-reminder>
 * 仅在两个连续 user 都包含 <system-reminder> 时：
 *   用后者的 <system-reminder> 文本覆盖前者的对应片段，并删除后者 message
 */
function mergeDuplicateSystemReminders(messages) {
  if (!Array.isArray(messages)) return false;
  let merged = false;
  let i = 0;
  while (i < messages.length - 1) {
    const first = messages[i];
    const second = messages[i + 1];
    if (first?.role !== "user" || second?.role !== "user") {
      i += 1;
      continue;
    }

    normalizeContentArray(first);
    normalizeContentArray(second);

    const firstSysIndex = first.content.findIndex(
      (c) =>
        c?.type === "text" &&
        typeof c.text === "string" &&
        c.text.includes("<system-reminder>"),
    );
    const secondSysText = second.content.find(
      (c) =>
        c?.type === "text" &&
        typeof c.text === "string" &&
        c.text.includes("<system-reminder>"),
    )?.text;

    if (firstSysIndex !== -1 && secondSysText) {
      const newText = replaceSystemReminderSection(
        first.content[firstSysIndex].text,
        secondSysText,
      );
      if (newText) {
        first.content[firstSysIndex].text = newText;
        messages.splice(i + 1, 1);
        merged = true;
        continue; // 当前位置可能仍有连续 user，继续检查
      }
    }

    i += 1;
  }
  return merged;
}

/**
 * 将字符串内容规范为 content 数组
 */
function normalizeContentArray(message) {
  if (!message) return;
  if (Array.isArray(message.content)) return;
  if (typeof message.content === "string") {
    message.content = [{ type: "text", text: message.content }];
    return;
  }
  message.content = [];
}

/**
 * 合并连续的 user messages 中重复的 <system-reminder>
 * 仅在两个连续 user 都包含 <system-reminder> 时：
 *   用后者的 <system-reminder> 文本覆盖前者的对应片段，并删除后者 message
 */
function mergeDuplicateSystemReminders(messages) {
  if (!Array.isArray(messages)) return false;
  let merged = false;
  let i = 0;
  while (i < messages.length - 1) {
    const first = messages[i];
    const second = messages[i + 1];
    if (first?.role !== "user" || second?.role !== "user") {
      i += 1;
      continue;
    }

    normalizeContentArray(first);
    normalizeContentArray(second);

    const firstSysIndex = first.content.findIndex(
      (c) =>
        c?.type === "text" &&
        typeof c.text === "string" &&
        c.text.includes("<system-reminder>"),
    );
    const secondSysTexts = second.content
      .filter(
        (c) =>
          c?.type === "text" &&
          typeof c.text === "string" &&
          c.text.includes("<system-reminder>"),
      )
      .map((c) => c.text);

    if (firstSysIndex !== -1 && secondSysTexts.length > 0) {
      first.content[firstSysIndex].text = secondSysTexts.join("\n\n");
      messages.splice(i + 1, 1);
      merged = true;
      // merge 后继续检查当前位置，防止多段连续 user
      continue;
    }

    i += 1;
  }
  return merged;
}

/**
 * 重写请求：将 droid 格式转换为 claude-code 兼容格式
 *
 * 核心改动：
 * 1. 替换 system 字段为 claude-code 的 system prompt
 * 2. 将 droid 原来的 system text 移到 messages 中作为 user 消息
 * 3. 使用 claude-code 的 tools
 * 4. 修改 headers 以匹配 claude-code 格式
 */
function rewriteRequest(params) {
  requestCounter++;
  let { method, url, headers, body } = params;

  // 记录原始请求
  logToFile("1-original-request", {
    method,
    url,
    headers,
    bodyParsed: body ? safeParseJSON(body) : null,
  });

  if (!body) {
    logToFile("2-no-body-skip", { reason: "no body provided" });
    return {};
  }

  try {
    const requestBody = JSON.parse(body);

    // 记录解析后的请求体结构
    logToFile("3-parsed-body-structure", {
      model: requestBody.model,
      hasSystem: !!requestBody.system,
      systemType: Array.isArray(requestBody.system)
        ? "array"
        : typeof requestBody.system,
      systemPreview: Array.isArray(requestBody.system)
        ? requestBody.system.map((s) => s.text?.substring(0, 80))
        : String(requestBody.system).substring(0, 200),
      messagesCount: requestBody.messages?.length,
      hasTools: !!requestBody.tools,
      toolsCount: requestBody.tools?.length,
      hasMetadata: !!requestBody.metadata,
      maxTokens: requestBody.max_tokens,
      stream: requestBody.stream,
    });

    // 检测是否是 droid 请求
    if (!isDroidRequest(requestBody)) {
      logToFile("4-not-droid-skip", { reason: "not a droid request" });
      return {};
    }

    console.error("[droid-to-claude] Detected droid request, rewriting...");

    // ========== 1. 提取 droid 原来的 system text ==========
    const droidSystemText = extractSystemText(requestBody.system);
    logToFile("5-droid-system", {
      textLength: droidSystemText.length,
      preview: droidSystemText.substring(0, 200),
    });

    // ========== 2. 替换 system 字段为 claude-code 的 system，并添加 droid 的 system text ==========
    const claudeCodeSystem = claudeCodeReqRef.system;
    requestBody.system = claudeCodeSystem;

    const droidSystemContent = {
      type: "text",
      text: `<droid-system-context>\n${droidSystemText}\n</droid-system-context>`,
      cache_control: { type: "ephemeral" },
    };
    requestBody.system.push(droidSystemContent);

    // ========== 3. 合并连续 user 中重复的 <system-reminder>，避免缓存冲突 400 ==========
    const mergedSystemReminder = mergeDuplicateSystemReminders(
      requestBody.messages,
    );
    if (mergedSystemReminder) {
      logToFile("5b-system-reminder-merged", {
        messageCount: requestBody.messages.length,
      });
    }

    // ========== 4. 保留 droid 的 tools（测试：不替换） ==========
    if (requestBody.tools && requestBody.tools.length > 0) {
      logToFile("6-droid-tools-kept", {
        toolNames: requestBody.tools.map((t) => t.name),
        toolsCount: requestBody.tools.length,
      });
      // 保留原始 droid tools，不替换
      console.error(
        `[droid-to-claude] Keeping original droid tools (${requestBody.tools.length} tools)`,
      );
    }

    // ========== 5. 添加 metadata（关键！88code.org 通过这个验证 claude-code） ==========
    if (!requestBody.metadata) {
      requestBody.metadata = claudeCodeReqRef.metadata;
    }
    logToFile("6d-metadata", { metadata: requestBody.metadata });

    const newBody = JSON.stringify(requestBody);

    // ========== 6. 修改 headers 以匹配 claude-code 格式 ==========
    const newHeaders = { ...headers };

    // 添加 anthropic-beta header（关键！）
    newHeaders["anthropic-beta"] =
      "claude-code-20250219,interleaved-thinking-2025-05-14";

    // 转换认证方式：x-api-key -> authorization Bearer
    if (newHeaders["x-api-key"] && !newHeaders["authorization"]) {
      newHeaders["authorization"] = `Bearer ${newHeaders["x-api-key"]}`;
      delete newHeaders["x-api-key"];
    }

    // 添加其他 claude-code 特有的 headers
    newHeaders["x-app"] = "cli";
    newHeaders["anthropic-dangerous-direct-browser-access"] = "true";

    // 更新 user-agent
    newHeaders["user-agent"] = "claude-cli/2.0.58 (external, cli)";

    logToFile("6c-modified-headers", {
      originalHeaders: Object.keys(headers),
      newHeaders: Object.keys(newHeaders),
      hasAnthropicBeta: !!newHeaders["anthropic-beta"],
      hasAuthorization: !!newHeaders["authorization"],
    });

    // 记录修改后的请求
    logToFile("7-modified-body", {
      model: requestBody.model,
      systemPreview: Array.isArray(requestBody.system)
        ? requestBody.system.map((s) => s.text?.substring(0, 80))
        : String(requestBody.system).substring(0, 200),
      messagesCount: requestBody.messages?.length,
      hasTools: !!requestBody.tools,
      toolsCount: requestBody.tools?.length,
      hasMetadata: !!requestBody.metadata,
      bodyLength: newBody.length,
    });

    // 记录完整的修改后请求（用于调试）
    logToFile("8-modified-body-full", safeParseJSON(newBody));

    console.error("[droid-to-claude] Request rewritten successfully");
    return { body: newBody, headers: newHeaders };
  } catch (e) {
    logToFile("error", { message: e.message, stack: e.stack });
    console.error("[droid-to-claude] Parse error:", e.message);
    return {};
  }
}

/**
 * 安全解析 JSON
 */
function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return { parseError: true, preview: str.substring(0, 500) };
  }
}

/**
 * 处理 JSON-RPC 请求
 */
function handleRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case "rewrite_request":
      const result = rewriteRequest(params);
      sendResponse(id, result);
      break;

    case "rewrite_response_headers":
      // 不修改响应头
      sendResponse(id, {});
      break;

    case "transform_chunk":
      // 直接透传响应数据
      sendResponse(id, { data: params.data });
      break;

    case "end_stream":
      // 流结束，无额外数据
      sendResponse(id, {});
      break;

    default:
      sendResponse(id, null, {
        code: -32601,
        message: `Method not found: ${method}`,
      });
  }
}

// 处理输入行
rl.on("line", (line) => {
  if (!line.trim()) return;

  try {
    const request = JSON.parse(line);
    if (request.jsonrpc === "2.0" && request.method) {
      handleRequest(request);
    }
  } catch (e) {
    console.error("[droid-to-claude] JSON parse error:", e.message);
  }
});

// 进程退出处理
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

console.error("[droid-to-claude] Hook started");
