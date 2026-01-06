/**
 * 请求转换器
 *
 * 将 Anthropic Messages API 请求转换为 Gemini generateContent 请求
 */

import type {
  AnthropicRequestBody,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolChoice,
  GeminiRequestBody,
  GeminiContent,
  GeminiPart,
  GeminiFunctionDeclaration,
  GeminiToolConfig,
  GeminiGenerationConfig,
  RequestConversionResult,
} from "./types";

/**
 * 从 Anthropic 请求中提取 cwd (当前工作目录)
 * 查找 messages 或 system 中 "% pwd" 命令的输出
 */
export function extractCwd(body: AnthropicRequestBody): string | null {
  // 先从 system 中查找
  if (body.system) {
    const systemText = extractSystemText(body.system);
    // 查找 "% pwd\n/path/to/dir" 模式
    const pwdMatch = systemText.match(/% pwd\s*\n([^\n]+)/);
    if (pwdMatch && pwdMatch[1]) {
      return pwdMatch[1].trim();
    }
  }
  
  // 从 messages 中查找
  for (const msg of body.messages) {
    const content = msg.content;
    let text = "";
    
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map(b => ("text" in b ? b.text : ""))
        .join("\n");
    }
    
    // 查找 "% pwd\n/path/to/dir" 模式
    const pwdMatch = text.match(/% pwd\s*\n([^\n]+)/);
    if (pwdMatch && pwdMatch[1]) {
      return pwdMatch[1].trim();
    }
  }
  
  return null;
}

/**
 * 检测是否包含 web_search 服务端工具
 */
function hasWebSearchTool(body: AnthropicRequestBody): boolean {
  if (!Array.isArray(body.tools)) return false;
  return body.tools.some(
    (tool) => "type" in tool && tool.type === "web_search_20250305"
  );
}

/**
 * 检测是否为 Droid 请求
 * 
 * 注意：如果请求包含 web_search_20250305 工具（如 websearch-native 发起的搜索请求），
 * 也视为需要处理的请求，这与 anthropic4droid 的行为一致。
 */
export function isDroidRequest(body: AnthropicRequestBody): boolean {
  // 如果包含 web_search 工具，也视为需要处理的请求
  // 这是 websearch-native 发起的搜索请求
  if (hasWebSearchTool(body)) {
    return true;
  }

  if (!body.system) return false;

  const systemText = extractSystemText(body.system);
  return (
    systemText.includes("Droid") ||
    systemText.includes("Factory") ||
    systemText.includes("factory-droid")
  );
}

/**
 * 提取 system 文本
 */
export function extractSystemText(
  system: string | AnthropicTextBlock[] | undefined
): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((s) => s.text || "").join("\n\n");
}

/**
 * 转换 Anthropic role 到 Gemini role
 */
function convertRole(role: "user" | "assistant"): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

/**
 * 工具名映射：Anthropic -> Gemini
 */
const TOOL_NAME_TO_GEMINI: Record<string, string> = {
  WebSearch: "google_web_search",
};

/**
 * 工具名映射：Gemini -> Anthropic
 */
const TOOL_NAME_TO_ANTHROPIC: Record<string, string> = {
  google_web_search: "WebSearch",
};

/**
 * 从消息数组中构建 tool_use_id -> name 的映射
 * 注意：存储的是 Gemini 格式的名称
 */
function buildToolUseIdToNameMap(messages: AnthropicMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          // 转换工具名为 Gemini 格式
          const geminiName = TOOL_NAME_TO_GEMINI[block.name] || block.name;
          map.set(block.id, geminiName);
        }
      }
    }
  }
  return map;
}

/**
 * 转换单个 content block 到 Gemini part
 */
function convertContentBlock(
  block: AnthropicContentBlock,
  toolUseIdToName: Map<string, string>
): GeminiPart | null {
  switch (block.type) {
    case "text":
      return { text: block.text };

    case "image":
      return {
        inline_data: {
          mime_type: block.source.media_type,
          data: block.source.data,
        },
      };

    case "tool_use":
      // 转换工具名为 Gemini 格式
      const geminiToolName = TOOL_NAME_TO_GEMINI[block.name] || block.name;
      // 如果是 WebSearch -> google_web_search，只保留 query 参数
      const toolArgs = geminiToolName === "google_web_search" && block.input
        ? { query: (block.input as Record<string, unknown>).query }
        : block.input;
      return {
        functionCall: {
          name: geminiToolName,
          args: toolArgs,
        },
      };

    case "tool_result":
      // tool_result 需要特殊处理，转换为 functionResponse (camelCase)
      const responseContent =
        typeof block.content === "string"
          ? block.content
          : block.content
              .filter((c): c is AnthropicTextBlock => c.type === "text")
              .map((c) => c.text)
              .join("\n");

      // 从映射中获取函数名
      const functionName = toolUseIdToName.get(block.tool_use_id) || block.tool_use_id;

      return {
        functionResponse: {
          id: block.tool_use_id,
          name: functionName,
          response: {
            output: responseContent,
          },
        },
      };

    case "thinking":
      // Gemini 不直接支持 thinking blocks，转换为普通文本
      return { text: `<thinking>${block.thinking}</thinking>` };

    default:
      return null;
  }
}

/**
 * 转换 Anthropic message 到 Gemini content
 */
function convertMessage(
  message: AnthropicMessage,
  toolUseIdToName: Map<string, string>
): GeminiContent {
  const parts: GeminiPart[] = [];

  if (typeof message.content === "string") {
    parts.push({ text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const part = convertContentBlock(block, toolUseIdToName);
      if (part) {
        parts.push(part);
      }
    }
  }

  // 确保至少有一个 part
  if (parts.length === 0) {
    parts.push({ text: "" });
  }

  return {
    role: convertRole(message.role),
    parts,
  };
}

/**
 * 合并连续相同 role 的消息
 * Gemini 要求 user 和 model 交替出现
 */
function mergeConsecutiveMessages(contents: GeminiContent[]): GeminiContent[] {
  if (contents.length === 0) return contents;

  const merged: GeminiContent[] = [];
  let current: GeminiContent | null = null;

  for (const content of contents) {
    if (current && current.role === content.role) {
      // 合并 parts
      current.parts.push(...content.parts);
    } else {
      if (current) {
        merged.push(current);
      }
      current = { ...content, parts: [...content.parts] };
    }
  }

  if (current) {
    merged.push(current);
  }

  return merged;
}

/**
 * 确保消息以 user 开头
 * Gemini 要求第一条消息必须是 user
 */
function ensureStartsWithUser(contents: GeminiContent[]): GeminiContent[] {
  if (contents.length === 0) {
    return [{ role: "user", parts: [{ text: "Hello" }] }];
  }

  const first = contents[0];
  if (first && first.role === "model") {
    // 在开头插入一个空的 user 消息
    return [{ role: "user", parts: [{ text: "Continue." }] }, ...contents];
  }

  return contents;
}

/**
 * 转换 messages 数组
 */
function convertMessages(messages: AnthropicMessage[]): GeminiContent[] {
  // 先构建 tool_use_id -> name 的映射
  const toolUseIdToName = buildToolUseIdToNameMap(messages);
  
  const contents = messages.map(msg => convertMessage(msg, toolUseIdToName));
  const merged = mergeConsecutiveMessages(contents);
  return ensureStartsWithUser(merged);
}

/**
 * 转换 Anthropic tool 到 Gemini function declaration (使用 parametersJsonSchema)
 */
function convertTool(tool: AnthropicTool): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.input_schema
      ? {
          type: "object",
          properties: tool.input_schema.properties,
          required: tool.input_schema.required,
        }
      : undefined,
  };
}

/**
 * 转换 tool_choice 到 Gemini toolConfig (使用 camelCase)
 */
function convertToolChoice(
  toolChoice: AnthropicToolChoice | undefined
): GeminiToolConfig | undefined {
  if (!toolChoice) return undefined;

  switch (toolChoice.type) {
    case "auto":
      return {
        functionCallingConfig: {
          mode: "AUTO",
        },
      };
    case "any":
      return {
        functionCallingConfig: {
          mode: "ANY",
        },
      };
    case "none":
      return {
        functionCallingConfig: {
          mode: "NONE",
        },
      };
    case "tool":
      return {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [
            TOOL_NAME_TO_GEMINI[toolChoice.name] || toolChoice.name,
          ],
        },
      };
    default:
      return undefined;
  }
}

/**
 * 构建 generationConfig (使用 camelCase，模仿 Gemini CLI)
 */
function buildGenerationConfig(
  body: AnthropicRequestBody,
  model: string
): GeminiGenerationConfig {
  const config: GeminiGenerationConfig = {};

  // 默认值 (模仿 Gemini CLI)
  config.temperature = body.temperature ?? 0.1;
  config.topP = body.top_p ?? 0.95;

  if (body.max_tokens !== undefined) {
    config.maxOutputTokens = body.max_tokens;
  }

  if (body.top_k !== undefined) {
    config.topK = body.top_k;
  }

  // 从 Anthropic thinking 配置转换到 Gemini thinkingConfig
  if (body.thinking?.type === "enabled") {
    config.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: body.thinking.budget_tokens ?? 8192,
    };
  } else {
    // 为支持 thinking 的模型添加默认 thinkingConfig
    const supportsThinking = model.includes("2.5") || model.includes("thinking");
    if (supportsThinking) {
      config.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: 8192,
      };
    }
  }

  return config;
}

/**
 * 转换请求体 (使用 camelCase，模仿 Gemini CLI)
 */
export function convertRequestBody(
  body: AnthropicRequestBody
): GeminiRequestBody {
  const model = body.model || "gemini-2.5-pro";
  
  const geminiBody: GeminiRequestBody = {
    contents: convertMessages(body.messages),
  };

  // 转换 system prompt (使用 camelCase: systemInstruction)
  if (body.system) {
    const systemText = extractSystemText(body.system);
    if (systemText) {
      geminiBody.systemInstruction = {
        parts: [{ text: systemText }],
      };
    }
  }

  // 转换 tools (使用 camelCase: functionDeclarations)
  if (body.tools && body.tools.length > 0) {
    // 检测是否有 web_search_20250305 服务端工具（如 websearch-native 请求）
    const hasServerWebSearch = body.tools.some(
      (t) => "type" in t && t.type === "web_search_20250305"
    );

    // 处理"工具声明"类对象（需要 name 字段但不是 web_search_20250305 类型）
    const declaredTools = body.tools.filter(
      (t): t is AnthropicTool => {
        // 排除 web_search_20250305 类型的工具
        if ("type" in t && t.type === "web_search_20250305") return false;
        return Boolean(t && typeof (t as AnthropicTool).name === "string");
      }
    );

    const toolsArray: GeminiRequestBody["tools"] = [];

    // 如果有 web_search_20250305，添加 Gemini 的 googleSearch grounding 工具
    // 注意：对于 Gemini 2.0+ 模型，只能使用 googleSearch，模型自动决定是否搜索
    // google_search_retrieval 只适用于 Gemini 1.5 模型
    if (hasServerWebSearch) {
      toolsArray.push({ googleSearch: {} });
    }

    // 转换其他工具声明
    if (declaredTools.length > 0) {
      const convertedTools = declaredTools.map(tool => {
        if (tool.name === "WebSearch") {
          // 转换为 Gemini CLI 的 google_web_search 格式
          return {
            name: "google_web_search",
            description: "Performs a web search using Google Search (via the Gemini API) and returns the results. This tool is useful for finding information on the internet based on a query.",
            parametersJsonSchema: {
              type: "object" as const,
              properties: {
                query: {
                  type: "string",
                  description: "The search query to find information on the web.",
                },
              },
              required: ["query"],
            },
          };
        }
        return convertTool(tool);
      });

      toolsArray.push({
        functionDeclarations: convertedTools,
      });
    }

    if (toolsArray.length > 0) {
      geminiBody.tools = toolsArray;
    }

    // 注意：如果只有 googleSearch grounding 工具（没有 function declarations），
    // 不应该设置 toolConfig，因为 googleSearch 不支持 toolConfig.functionCallingConfig
    // 转换 tool_choice (使用 camelCase: toolConfig)
    // 只有在有 function declarations 时才设置 toolConfig
    if (declaredTools.length > 0) {
      const toolConfig = convertToolChoice(body.tool_choice);
      if (toolConfig) {
        geminiBody.toolConfig = toolConfig;
      }
    }
  }

  // 构建 generationConfig (使用 camelCase)
  geminiBody.generationConfig = buildGenerationConfig(body, model);

  return geminiBody;
}

/**
 * 重写请求头
 * 模仿 Gemini CLI 的请求头格式
 */
export function convertHeaders(
  headers: Record<string, string>,
  options?: { apiKey?: string; model?: string }
): Record<string, string> {
  const newHeaders: Record<string, string> = {};

  // === 必需的 headers ===
  newHeaders["content-type"] = "application/json";
  newHeaders["accept"] = "*/*";
  newHeaders["accept-language"] = "*";
  newHeaders["accept-encoding"] = "gzip, deflate";
  newHeaders["connection"] = "keep-alive";
  newHeaders["sec-fetch-mode"] = "cors";

  // === Google API 特定 headers ===
  // 模仿 Gemini CLI 的 user-agent
  const model = options?.model || "gemini-2.5-pro";
  newHeaders["user-agent"] = `GeminiCLI/0.22.5/${model} (darwin; arm64)`;

  // Google SDK 标识
  newHeaders["x-goog-api-client"] = "google-genai-sdk/1.30.0 gl-node/v25.2.1";

  // Gemini CLI 用户标识 (模仿 Gemini CLI 的行为)
  newHeaders["x-gemini-api-privileged-user-id"] = "13271059-2002-40d2-9379-c006f33f367f";

  // === API Key 处理 ===
  // 优先级: options.apiKey > x-goog-api-key > x-api-key > authorization header
  if (options?.apiKey) {
    newHeaders["x-goog-api-key"] = options.apiKey;
  } else if (headers["x-goog-api-key"]) {
    // 保留原始的 x-goog-api-key
    newHeaders["x-goog-api-key"] = headers["x-goog-api-key"];
  } else if (headers["x-api-key"]) {
    // Anthropic 格式转换为 Gemini 格式
    newHeaders["x-goog-api-key"] = headers["x-api-key"];
  } else if (headers["authorization"]) {
    // 提取 Bearer token 作为 API key
    const authHeader = headers["authorization"];
    if (authHeader.startsWith("Bearer ")) {
      newHeaders["x-goog-api-key"] = authHeader.slice(7);
    } else {
      newHeaders["authorization"] = authHeader;
    }
  }

  // === 复制 host header (如果存在) ===
  if (headers["host"]) {
    newHeaders["host"] = headers["host"];
  }

  // === 注意：以下 Anthropic 特定的 headers 不需要复制 ===
  // - anthropic-version
  // - x-stainless-*

  return newHeaders;
}

/**
 * 构建 Gemini API URL
 */
export function buildGeminiUrl(
  baseUrl: string,
  model: string,
  stream: boolean
): string {
  // 标准化 model 名称
  let geminiModel = model;
  if (!geminiModel.startsWith("models/")) {
    geminiModel = `models/${geminiModel}`;
  }

  const action = stream ? "streamGenerateContent" : "generateContent";
  const streamParam = stream ? "?alt=sse" : "";

  // 移除末尾的斜杠
  const base = baseUrl.replace(/\/+$/, "");

  return `${base}/${geminiModel}:${action}${streamParam}`;
}

/**
 * 转换整个请求
 */
export function convertRequest(params: {
  headers: Record<string, string>;
  body: string;
  upstreamBaseUrl?: string;
}): RequestConversionResult {
  const { headers, body, upstreamBaseUrl } = params;

  if (!body) {
    return {};
  }

  let requestBody: AnthropicRequestBody;
  try {
    requestBody = JSON.parse(body) as AnthropicRequestBody;
  } catch {
    return {};
  }

  // 检测是否为 Droid 请求
  if (!isDroidRequest(requestBody)) {
    return {};
  }

  // 转换请求体
  const geminiBody = convertRequestBody(requestBody);

  // 转换 headers (传入 model 用于 user-agent)
  const geminiHeaders = convertHeaders(headers, { model: requestBody.model });

  // 构建结果
  const result: RequestConversionResult = {
    headers: geminiHeaders,
    body: JSON.stringify(geminiBody),
  };

  // 如果提供了上游 URL，构建完整的 Gemini URL
  if (upstreamBaseUrl && requestBody.model) {
    result.url = buildGeminiUrl(
      upstreamBaseUrl,
      requestBody.model,
      requestBody.stream ?? false
    );
  }

  return result;
}
