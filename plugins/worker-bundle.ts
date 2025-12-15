/**
 * Worker Bundle Plugin
 *
 * Bun build plugin 用于处理 Worker 文件的打包：
 * - 开发模式：直接使用 TS 文件
 * - 打包模式：预编译 Worker 为 JS，重写 import 路径
 *
 * 使用方式：
 * ```ts
 * // 源码中使用 with { type: "file" } 导入 Worker
 * import workerPath from "./proxy-server.ts" with { type: "file" };
 * new Worker(workerPath, { argv });
 * ```
 *
 * 打包时 plugin 会：
 * 1. 预编译 Worker TS 文件为 JS（包含所有依赖）
 * 2. 重写 import 路径指向预编译的 JS 文件
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { BunPlugin } from "bun";

export interface WorkerBundleOptions {
  /** Worker 输出目录（相对于项目根目录） */
  outdir?: string;
  /** 是否压缩 Worker 代码 */
  minify?: boolean;
  /** 需要排除的外部模块 */
  external?: string[];
}

/**
 * 扫描源文件，找到所有 with { type: "file" } 导入的 .ts 文件
 */
export function findWorkerImports(entryPaths: string[]): string[] {
  const workers = new Set<string>();

  for (const entryPath of entryPaths) {
    scanFileForWorkers(entryPath, workers, new Set());
  }

  return [...workers];
}

function scanFileForWorkers(filePath: string, workers: Set<string>, visited: Set<string>): void {
  if (visited.has(filePath)) return;
  visited.add(filePath);

  if (!fs.existsSync(filePath)) return;

  const source = fs.readFileSync(filePath, "utf-8");
  const dir = path.dirname(filePath);

  // 匹配 import xxx from "./yyy.ts" with { type: "file" }
  const workerPattern =
    /import\s+\w+\s+from\s+["'](\.[^"']+\.ts)["']\s+with\s*\{\s*type:\s*["']file["']\s*\}/g;
  let match;

  while ((match = workerPattern.exec(source)) !== null) {
    const relativePath = match[1];
    if (relativePath) {
      const absolutePath = path.resolve(dir, relativePath);
      workers.add(absolutePath);
    }
  }

  // 递归扫描普通 import（支持带或不带 .ts 后缀）
  // 匹配: import xxx from "./path" 或 import { xxx } from "./path"
  const importPattern = /import\s+(?:[\w{},\s*]+\s+from\s+)?["'](\.\/[^"']+)["'](?!\s+with)/g;
  while ((match = importPattern.exec(source)) !== null) {
    let relativePath = match[1];
    if (relativePath) {
      // 尝试解析文件路径（可能需要添加 .ts 后缀）
      let absolutePath = path.resolve(dir, relativePath);

      // 如果没有 .ts 后缀，尝试添加
      if (!absolutePath.endsWith(".ts")) {
        if (fs.existsSync(absolutePath + ".ts")) {
          absolutePath = absolutePath + ".ts";
        } else if (fs.existsSync(path.join(absolutePath, "index.ts"))) {
          absolutePath = path.join(absolutePath, "index.ts");
        }
      }

      if (fs.existsSync(absolutePath)) {
        scanFileForWorkers(absolutePath, workers, visited);
      }
    }
  }
}

/**
 * 预编译 Worker 文件
 * @returns Map<原始绝对路径, 编译后绝对路径>
 */
export async function buildWorkers(
  workers: string[],
  options: WorkerBundleOptions = {}
): Promise<Map<string, string>> {
  const { outdir = ".build-worker", minify = true, external = [] } = options;
  const mapping = new Map<string, string>();

  const absoluteOutdir = path.resolve(process.cwd(), outdir);
  fs.mkdirSync(absoluteOutdir, { recursive: true });

  for (const workerPath of workers) {
    const basename = path.basename(workerPath, ".ts");
    const outFile = `${basename}.js`;

    console.log(`  Building worker: ${path.basename(workerPath)}`);

    const result = await Bun.build({
      entrypoints: [workerPath],
      outdir: absoluteOutdir,
      target: "bun",
      minify,
      naming: outFile,
      external,
    });

    if (!result.success) {
      console.error("Worker build failed:", result.logs);
      throw new Error(`Worker build failed for ${workerPath}`);
    }

    mapping.set(workerPath, path.join(absoluteOutdir, outFile));
  }

  return mapping;
}

/**
 * 创建 Worker Bundle Plugin
 *
 * 在 Bun.build 时重写 import 路径：
 * - `import workerPath from "./worker.ts" with { type: "file" }`
 * - 变成 `import workerPath from "./.build-worker/worker.js" with { type: "file" }`
 */
export function createWorkerBundlePlugin(mapping: Map<string, string>): BunPlugin {
  return {
    name: "worker-bundle",
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async (args) => {
        let source = await Bun.file(args.path).text();
        let modified = false;

        for (const [originalPath, bundledPath] of mapping) {
          // 计算相对于当前文件的原始路径和新路径
          const relOriginal = path.relative(path.dirname(args.path), originalPath);
          const relBundled = path.relative(path.dirname(args.path), bundledPath);

          // 保持正确的相对路径格式（../xxx 或 ./xxx）
          const originalRelative = relOriginal.startsWith("..") ? relOriginal : "./" + relOriginal;
          const newRelative = relBundled.startsWith("..") ? relBundled : "./" + relBundled;

          // 转义正则特殊字符
          const escapedOriginal = originalRelative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

          // 匹配 import xxx from "./worker.ts" 或 "../worker.ts" with { type: "file" }
          const pattern = new RegExp(
            `(import\\s+\\w+\\s+from\\s+["'])${escapedOriginal}(["']\\s+with\\s*\\{\\s*type:\\s*["']file["']\\s*\\})`,
            "g"
          );

          const newSource = source.replace(pattern, `$1${newRelative}$2`);
          if (newSource !== source) {
            console.log(`  Rewriting: ${originalRelative} -> ${newRelative}`);
            source = newSource;
            modified = true;
          }
        }

        if (modified) {
          return { contents: source, loader: "ts" };
        }
      });
    },
  };
}
