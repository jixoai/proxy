/**
 * Web Search 功能
 *
 * 完全模拟 gemini-cli 的处理方式：
 * 1. 使用 googleSearch grounding 执行搜索
 * 2. 将搜索结果作为 functionResponse 发回 Gemini
 * 3. 获取 Gemini 基于搜索结果的最终回答
 */

import { execSync } from "node:child_process";

export interface WebSearchResult {
  type: "web_search_result";
  url: string;
  title: string;
  snippet: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  responseText: string;
}

/**
 * 使用 Gemini googleSearch grounding 执行搜索
 */
export function executeWebSearch(
  query: string,
  apiKey: string,
  baseUrl: string
): WebSearchResponse {
  try {
    const searchUrl = `${baseUrl}/models/gemini-2.5-pro:generateContent`;

    const requestBody = {
      contents: [
        {
          parts: [{ text: query }],
          role: "user",
        },
      ],
      tools: [{ googleSearch: {} }],
      generationConfig: {
        temperature: 0,
        topP: 1,
      },
    };

    const bodyStr = JSON.stringify(requestBody).replace(/'/g, "'\\''");
    const curlCmd = `curl -s -X POST "${searchUrl}" -H "Content-Type: application/json" -H "x-goog-api-key: ${apiKey}" -d '${bodyStr}'`;

    const responseStr = execSync(curlCmd, {
      encoding: "utf-8",
      timeout: 60000,
    });

    const response = JSON.parse(responseStr);

    if (response.error) {
      return {
        results: [],
        responseText: `Search failed: ${response.error.message}`,
      };
    }

    // 提取响应文本
    const parts = response.candidates?.[0]?.content?.parts || [];
    let responseText = "";
    for (const part of parts) {
      if (part.text && !part.thought) {
        responseText += part.text;
      }
    }

    // 提取 grounding metadata
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const groundingChunks = groundingMetadata?.groundingChunks || [];

    let results: WebSearchResult[] = groundingChunks.map(
      (chunk: { web?: { uri?: string; title?: string } }) => ({
        type: "web_search_result" as const,
        url: chunk.web?.uri || "",
        title: chunk.web?.title || "",
        snippet: chunk.web?.title || "",
      })
    );

    if (!responseText) {
      responseText = `No search results found for "${query}".`;
    }

    // 确保 results 不为空
    if (results.length === 0 && responseText) {
      results = [{
        type: "web_search_result" as const,
        url: "",
        title: `Search results for: ${query}`,
        snippet: responseText,
      }];
    }

    return { results, responseText };
  } catch (error) {
    return {
      results: [{
        type: "web_search_result" as const,
        url: "",
        title: "Search error",
        snippet: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      responseText: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 完整的 gemini-cli 风格搜索流程：
 * 1. 执行搜索
 * 2. 将搜索结果作为 functionResponse 发回 Gemini
 * 3. 返回 Gemini 的最终回答（SSE 格式）
 */
export function executeWebSearchWithContinuation(
  query: string,
  originalContents: unknown[],
  functionCallId: string,
  thoughtSignature: string,
  apiKey: string,
  baseUrl: string
): string {
  // 1. 执行搜索
  const searchResponse = executeWebSearch(query, apiKey, baseUrl);
  
  // 2. 构建 functionResponse 请求
  const functionResponseContent = {
    role: "user",
    parts: [{
      functionResponse: {
        id: functionCallId,
        name: "google_web_search",
        response: {
          output: `Web search results for "${query}":\n\n${searchResponse.responseText}`,
        },
      },
    }],
  };

  // 3. 发送包含 functionResponse 的请求给 Gemini（流式）
  const continueUrl = `${baseUrl}/models/gemini-2.5-pro:streamGenerateContent?alt=sse`;
  
  const continueBody = {
    contents: [
      ...originalContents,
      // 添加 functionCall 响应
      {
        role: "model",
        parts: [{
          thoughtSignature,
          functionCall: {
            name: "google_web_search",
            args: { query },
          },
        }],
      },
      functionResponseContent,
    ],
    generationConfig: {
      temperature: 1,
      topP: 0.95,
      topK: 64,
      responseModalities: ["TEXT"],
      thinkingConfig: { thinkingBudget: 8192 },
    },
    // 保持原有的 tools 配置
    tools: [{ googleSearch: {} }],
  };

  try {
    const bodyStr = JSON.stringify(continueBody).replace(/'/g, "'\\''");
    const curlCmd = `curl -s -X POST "${continueUrl}" -H "Content-Type: application/json" -H "x-goog-api-key: ${apiKey}" -d '${bodyStr}'`;

    const responseStr = execSync(curlCmd, {
      encoding: "utf-8",
      timeout: 120000,
    });

    return responseStr;
  } catch (error) {
    // 如果续请求失败，返回搜索结果作为最终响应
    return `data: {"candidates": [{"content": {"role": "model", "parts": [{"text": "${searchResponse.responseText.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"}]}, "finishReason": "STOP"}]}\n\n`;
  }
}
