import { spawn } from "node:child_process";

export type FormatRequest = {
  code: string;
  filename: string;
};

export type FormatResponse =
  | { success: true; formatted: string }
  | { success: false; error: string };

/**
 * 使用 Biome CLI native 版本格式化代码
 * 比 WASM 版本性能更好 (5-10x 提升)
 *
 * @param request - 格式化请求
 * @returns Promise<FormatResponse>
 *
 * @example
 * const result = await formatCode({
 *   code: 'const x=1',
 *   filename: 'test.js'
 * });
 */
export async function formatCode(
  request: FormatRequest,
): Promise<FormatResponse> {
  const { code, filename } = request;

  return new Promise((resolve) => {
    // 使用 bun @biomejs/biome format 命令，从 stdin 读取代码
    // --stdin-file-path 用于推断文件类型
    const biomeProcess = spawn(
      "bun",
      ["biome", "format", "--stdin-file-path", filename],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    biomeProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    biomeProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    biomeProcess.on("close", (code) => {
      if (code === 0 && stdout) {
        resolve({ success: true, formatted: stdout });
      } else {
        resolve({
          success: false,
          error: stderr || `Biome exited with code ${code}`,
        });
      }
    });

    biomeProcess.on("error", (error) => {
      resolve({
        success: false,
        error: `Failed to spawn biome: ${error.message}`,
      });
    });

    // 将代码写入 stdin
    biomeProcess.stdin.write(code);
    biomeProcess.stdin.end();
  });
}
