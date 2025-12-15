/**
 * Worker Bundle Preload Script
 *
 * 用于 bun build --compile 时注册 runtime plugin
 * 使用方式：bun build --compile --preload ./plugins/worker-bundle-preload.ts
 *
 * 注意：此脚本在打包时会被执行，用于处理 `with { type: "file" }` 导入
 */

import { plugin } from "bun";
import * as path from "node:path";
import * as fs from "node:fs";

// Worker 构建输出目录（由 build.ts 预先构建）
const WORKER_BUILD_DIR = path.join(process.cwd(), ".build-worker");

// 检查是否存在预编译的 Worker
function getPrebuiltWorkerMapping(): Map<string, string> {
  const mapping = new Map<string, string>();
  
  if (!fs.existsSync(WORKER_BUILD_DIR)) {
    return mapping;
  }

  // 读取预编译的 Worker 文件
  const files = fs.readdirSync(WORKER_BUILD_DIR);
  for (const file of files) {
    if (file.endsWith(".js")) {
      const basename = path.basename(file, ".js");
      // 假设原始文件是 src/${basename}.ts
      const originalPath = path.join(process.cwd(), "src", `${basename}.ts`);
      const bundledPath = path.join(WORKER_BUILD_DIR, file);
      
      if (fs.existsSync(originalPath)) {
        mapping.set(originalPath, bundledPath);
      }
    }
  }

  return mapping;
}

const workerMapping = getPrebuiltWorkerMapping();

if (workerMapping.size > 0) {
  plugin({
    name: "worker-bundle-preload",
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async (args) => {
        let source = await Bun.file(args.path).text();

        // 检查是否包含 with { type: "file" } 导入
        if (!source.includes('with { type: "file" }') && !source.includes("with { type: 'file' }")) {
          return undefined;
        }

        let modified = false;

        for (const [originalPath, bundledPath] of workerMapping) {
          const relOriginal = path.relative(path.dirname(args.path), originalPath);
          const relBundled = path.relative(path.dirname(args.path), bundledPath);

          const originalRelative = relOriginal.startsWith("..") ? relOriginal : "./" + relOriginal;
          const newRelative = relBundled.startsWith("..") ? relBundled : "./" + relBundled;

          const escapedOriginal = originalRelative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

          const pattern = new RegExp(
            `(import\\s+\\w+\\s+from\\s+["'])${escapedOriginal}(["']\\s+with\\s*\\{\\s*type:\\s*["']file["']\\s*\\})`,
            "g"
          );

          const newSource = source.replace(pattern, `$1${newRelative}$2`);
          if (newSource !== source) {
            console.log(`[preload] Rewriting: ${originalRelative} -> ${newRelative}`);
            source = newSource;
            modified = true;
          }
        }

        if (modified) {
          return { contents: source, loader: "ts" };
        }
      });
    },
  });
}
