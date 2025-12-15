#!/usr/bin/env bun
/**
 * Jixo Proxy 构建脚本
 *
 * 支持的命令：
 *   bun run build.ts                    - 显示帮助
 *   bun run build.ts binary             - 构建当前平台的可执行文件
 *   bun run build.ts binary --all       - 构建所有平台的可执行文件
 *   bun run build.ts binary --target=linux-x64  - 构建指定平台
 */

import * as fs from "node:fs";
import * as path from "node:path";
// 使用 Bun 官方的 Tailwind CSS 插件
// 参考文档: https://bun.sh/docs/bundler/fullstack#tailwindcss-plugin
import tailwindPlugin from "bun-plugin-tailwind";
// Worker 打包插件
import { findWorkerImports, buildWorkers } from "./plugins/worker-bundle";

// 前端构建输出目录
const FRONTEND_BUILD_DIR = path.join(process.cwd(), ".build-frontend");
const FRONTEND_ENTRY = path.join(process.cwd(), "src", "viewer.html");
// Worker 构建输出目录
const WORKER_BUILD_DIR = path.join(process.cwd(), ".build-worker");

// 读取 package.json 获取版本号
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8"));
const VERSION = packageJson.version;
const NAME = "jixo-proxy";

// 支持的构建目标
const BUILD_TARGETS = [
  { name: "darwin-arm64", bunTarget: "bun-darwin-arm64", ext: "" },
  { name: "darwin-x64", bunTarget: "bun-darwin-x64", ext: "" },
  { name: "linux-x64", bunTarget: "bun-linux-x64", ext: "" },
  { name: "linux-arm64", bunTarget: "bun-linux-arm64", ext: "" },
  { name: "windows-x64", bunTarget: "bun-windows-x64", ext: ".exe" },
] as const;

type TargetName = (typeof BUILD_TARGETS)[number]["name"];

const DIST_DIR = path.join(process.cwd(), "dist");
const ENTRY_FILE = path.join(process.cwd(), "src", "cli.ts");
const WINDOWS_ICON = path.join(process.cwd(), "assets", "icon.ico");

/**
 * 预编译前端资源
 * 将 HTML/JS/CSS 编译并生成可嵌入的 TypeScript 模块
 *
 * 使用 Bun 官方的 Tailwind CSS 插件处理样式：
 * - 插件会自动处理 CSS 文件中的 @import "tailwindcss" 指令
 * - 无需单独运行 Tailwind CLI
 */
async function buildFrontend(): Promise<void> {
  console.log("  Building frontend assets...");

  // 清理并创建前端构建目录
  if (fs.existsSync(FRONTEND_BUILD_DIR)) {
    fs.rmSync(FRONTEND_BUILD_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(FRONTEND_BUILD_DIR, { recursive: true });

  // 使用 Bun bundler 编译前端，配置 Tailwind CSS 插件
  const result = await Bun.build({
    entrypoints: [FRONTEND_ENTRY],
    outdir: FRONTEND_BUILD_DIR,
    target: "browser",
    minify: true,
    // 使用 bun-plugin-tailwind 处理 Tailwind CSS
    // 插件会自动展开 @tailwind 指令和处理 utility classes
    plugins: [tailwindPlugin],
  });

  if (!result.success) {
    console.error("Frontend build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Frontend build failed");
  }

  // 读取生成的文件
  const files = fs.readdirSync(FRONTEND_BUILD_DIR);
  const htmlFile = files.find(f => f.endsWith(".html"));
  const jsFile = files.find(f => f.endsWith(".js"));
  const cssFile = files.find(f => f.endsWith(".css"));
  const svgFile = files.find(f => f.endsWith(".svg"));

  if (!htmlFile || !jsFile) {
    throw new Error("Frontend build missing required files");
  }

  // CSS 由 bun-plugin-tailwind 直接处理，已包含完整的 Tailwind 样式
  const cssContent = cssFile
    ? fs.readFileSync(path.join(FRONTEND_BUILD_DIR, cssFile), "utf-8")
    : "";

  let htmlContent = fs.readFileSync(path.join(FRONTEND_BUILD_DIR, htmlFile), "utf-8");
  const jsContent = fs.readFileSync(path.join(FRONTEND_BUILD_DIR, jsFile), "utf-8");
  const svgContent = svgFile
    ? fs.readFileSync(path.join(FRONTEND_BUILD_DIR, svgFile), "utf-8")
    : "";

  // 将 CSS 和 JS 内联到 HTML 中
  // 替换 link[stylesheet] 为内联 style
  if (cssFile) {
    const cssLinkRegex = /<link[^>]*rel="stylesheet"[^>]*href="[^"]*"[^>]*>/;
    htmlContent = htmlContent.replace(cssLinkRegex, `<style>${cssContent}</style>`);
  }

  // 替换 script[src] 为内联 script
  if (jsFile) {
    const scriptRegex = /<script[^>]*type="module"[^>]*src="[^"]*"[^>]*><\/script>/;
    htmlContent = htmlContent.replace(scriptRegex, `<script type="module">${jsContent}</script>`);
  }

  // 替换 favicon 为内联 data URL
  if (svgFile) {
    const svgBase64 = Buffer.from(svgContent).toString("base64");
    const faviconRegex = /<link[^>]*rel="icon"[^>]*href="[^"]*"[^>]*>/;
    htmlContent = htmlContent.replace(
      faviconRegex,
      `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${svgBase64}">`
    );
  }

  // 生成嵌入模块
  const moduleContent = `/**
 * 预编译的前端资源（由 build.ts 自动生成）
 * 请勿手动编辑此文件
 */

export const BUNDLED_VIEWER_HTML = ${JSON.stringify(htmlContent)};
`;

  fs.writeFileSync(
    path.join(FRONTEND_BUILD_DIR, "bundled-viewer.ts"),
    moduleContent
  );

  console.log("  Frontend assets built and inlined successfully");
}

/**
 * Worker 导入信息
 */
interface WorkerImportInfo {
  /** 包含 Worker 导入的源文件 */
  sourceFile: string;
  /** 原始导入路径（相对于源文件） */
  originalImportPath: string;
  /** Worker 源文件的绝对路径 */
  workerAbsolutePath: string;
  /** 预编译后的 JS 文件路径 */
  bundledJsPath: string;
}

/**
 * 预编译 Worker 脚本
 *
 * 将 Worker TS 文件编译为独立的 JS 文件，供 `with { type: "file" }` 导入
 *
 * @returns Worker 导入信息列表
 */
async function buildWorkerFiles(): Promise<WorkerImportInfo[]> {
  console.log("  Finding worker imports...");

  // 清理构建目录
  fs.rmSync(WORKER_BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORKER_BUILD_DIR, { recursive: true });

  // Step 1: 扫描入口文件找到所有 Worker 导入
  const workers = findWorkerImports([ENTRY_FILE]);
  console.log(`  Found ${workers.length} worker(s): ${workers.map(w => path.basename(w)).join(", ")}`);

  if (workers.length === 0) {
    return [];
  }

  // Step 2: 预编译所有 Worker
  console.log("  Building workers...");
  const workerMapping = await buildWorkers(workers, {
    outdir: WORKER_BUILD_DIR,
    minify: true,
  });

  // Step 3: 收集详细的导入信息
  const workerImports: WorkerImportInfo[] = [];
  
  // 找到包含 Worker 导入的源文件
  const sourceFiles = findFilesWithWorkerImports([ENTRY_FILE]);
  
  for (const [workerPath, bundledPath] of workerMapping) {
    for (const sourceFile of sourceFiles) {
      const source = fs.readFileSync(sourceFile, "utf-8");
      const relPath = path.relative(path.dirname(sourceFile), workerPath);
      const importPath = relPath.startsWith("..") ? relPath : "./" + relPath;
      
      // 检查这个源文件是否导入了这个 Worker
      const pattern = new RegExp(
        `import\\s+\\w+\\s+from\\s+["']${importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s+with\\s*\\{\\s*type:\\s*["']file["']\\s*\\}`,
        "g"
      );
      
      if (pattern.test(source)) {
        workerImports.push({
          sourceFile,
          originalImportPath: importPath,
          workerAbsolutePath: workerPath,
          bundledJsPath: bundledPath,
        });
      }
    }
  }

  return workerImports;
}

/**
 * 递归查找包含 Worker 导入的源文件
 */
function findFilesWithWorkerImports(entryPaths: string[]): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  
  function scan(filePath: string): void {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    
    if (!fs.existsSync(filePath)) return;
    
    const source = fs.readFileSync(filePath, "utf-8");
    const dir = path.dirname(filePath);
    
    // 检查是否有 Worker 导入
    if (source.includes('with { type: "file" }') || source.includes("with { type: 'file' }")) {
      files.push(filePath);
    }
    
    // 递归扫描普通 import
    const importPattern = /import\s+(?:[\w{},\s*]+\s+from\s+)?["'](\.\/[^"']+)["'](?!\s+with)/g;
    let match;
    while ((match = importPattern.exec(source)) !== null) {
      let relativePath = match[1];
      if (relativePath) {
        let absolutePath = path.resolve(dir, relativePath);
        if (!absolutePath.endsWith(".ts")) {
          if (fs.existsSync(absolutePath + ".ts")) {
            absolutePath = absolutePath + ".ts";
          } else if (fs.existsSync(path.join(absolutePath, "index.ts"))) {
            absolutePath = path.join(absolutePath, "index.ts");
          }
        }
        if (fs.existsSync(absolutePath)) {
          scan(absolutePath);
        }
      }
    }
  }
  
  for (const entry of entryPaths) {
    scan(entry);
  }
  
  return files;
}

/**
 * 临时修改源文件，将 Worker 导入路径改为预编译的 JS 文件
 * @returns 恢复函数
 */
function patchWorkerImports(workerImports: WorkerImportInfo[]): () => void {
  const backups = new Map<string, string>();
  
  for (const info of workerImports) {
    // 备份原始文件内容
    if (!backups.has(info.sourceFile)) {
      backups.set(info.sourceFile, fs.readFileSync(info.sourceFile, "utf-8"));
    }
    
    // 计算新的导入路径
    const newImportPath = path.relative(
      path.dirname(info.sourceFile),
      info.bundledJsPath
    );
    const normalizedPath = newImportPath.startsWith("..") ? newImportPath : "./" + newImportPath;
    
    // 修改文件
    let content = fs.readFileSync(info.sourceFile, "utf-8");
    const escapedOriginal = info.originalImportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(import\\s+\\w+\\s+from\\s+["'])${escapedOriginal}(["']\\s+with\\s*\\{\\s*type:\\s*["']file["']\\s*\\})`,
      "g"
    );
    
    const newContent = content.replace(pattern, `$1${normalizedPath}$2`);
    if (newContent !== content) {
      console.log(`  Patching: ${path.basename(info.sourceFile)} (${info.originalImportPath} -> ${normalizedPath})`);
      fs.writeFileSync(info.sourceFile, newContent, "utf-8");
    }
  }
  
  // 返回恢复函数
  return () => {
    for (const [file, content] of backups) {
      fs.writeFileSync(file, content, "utf-8");
    }
  };
}

function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function getCurrentPlatformTarget(): TargetName {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  } else if (platform === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux-x64";
  } else if (platform === "win32") {
    return "windows-x64";
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

async function buildBinary(targetName: TargetName): Promise<{ file: string; size: number }> {
  const target = BUILD_TARGETS.find((t) => t.name === targetName);
  if (!target) {
    throw new Error(`Unknown target: ${targetName}`);
  }

  const outfile = path.join(DIST_DIR, `${NAME}-${VERSION}-${target.name}${target.ext}`);

  console.log(`  Building for ${target.name}...`);

  // 收集预编译的 Worker 文件作为额外入口点
  const workerFiles: string[] = [];
  if (fs.existsSync(WORKER_BUILD_DIR)) {
    for (const f of fs.readdirSync(WORKER_BUILD_DIR)) {
      if (f.endsWith(".js")) {
        workerFiles.push(path.join(WORKER_BUILD_DIR, f));
      }
    }
  }

  const args = [
    "bun", "build",
    ENTRY_FILE,
    ...workerFiles,
    "--compile",
    `--target=${target.bunTarget}`,
    `--outfile=${outfile}`,
    "--minify",
  ];

  // Windows 特定选项（仅在 Windows 平台构建时可用）
  if (target.name === "windows-x64") {
    if (process.platform === "win32") {
      args.push(`--windows-title=Jixo Proxy`);
      args.push(`--windows-version=${VERSION}.0`);
      args.push(`--windows-description=Visual Proxy Server`);

      // 添加图标
      if (fs.existsSync(WINDOWS_ICON)) {
        args.push(`--windows-icon=${WINDOWS_ICON}`);
        console.log(`    Using icon: ${WINDOWS_ICON}`);
      }
    } else {
      console.log(`    Note: Windows metadata (title, icon, etc.) can only be embedded when building on Windows`);
    }
  }

  const result = await Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await result.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(result.stderr).text();
    throw new Error(`Build failed for ${target.name}: ${stderr}`);
  }

  const stats = fs.statSync(outfile);
  return { file: outfile, size: stats.size };
}

async function buildAllBinaries(): Promise<void> {
  console.log(`\n🏗️  Building ${NAME} v${VERSION} for all platforms...\n`);

  // 确保 dist 目录存在
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 先构建前端资源和 Worker
  await buildFrontend();
  const workerImports = await buildWorkerFiles();

  // 临时修改源文件，使用预编译的 Worker
  const restoreFiles = patchWorkerImports(workerImports);

  const results: Array<{ target: string; file: string; size: string; status: string }> = [];
  const start = performance.now();

  try {
    for (const target of BUILD_TARGETS) {
      try {
        const { file, size } = await buildBinary(target.name);
        results.push({
          target: target.name,
          file: path.basename(file),
          size: formatFileSize(size),
          status: "✅",
        });
      } catch (error) {
        results.push({
          target: target.name,
          file: "-",
          size: "-",
          status: `❌ ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    // 恢复源文件
    restoreFiles();
  }

  const end = performance.now();

  console.log("\n📦 Build Results:\n");
  console.table(results);
  console.log(`\n⏱️  Total time: ${((end - start) / 1000).toFixed(2)}s`);
  console.log(`📁 Output directory: ${DIST_DIR}\n`);
}

async function buildSingleBinary(targetName?: string): Promise<void> {
  const target = targetName || getCurrentPlatformTarget();
  console.log(`\n🏗️  Building ${NAME} v${VERSION} for ${target}...\n`);

  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 先构建前端资源和 Worker
  await buildFrontend();
  const workerImports = await buildWorkerFiles();

  // 临时修改源文件，使用预编译的 Worker
  const restoreFiles = patchWorkerImports(workerImports);

  const start = performance.now();

  try {
    const { file, size } = await buildBinary(target as TargetName);
    const end = performance.now();

    console.log(`\n✅ Build successful!`);
    console.log(`   File: ${file}`);
    console.log(`   Size: ${formatFileSize(size)}`);
    console.log(`   Time: ${((end - start) / 1000).toFixed(2)}s\n`);
  } catch (error) {
    console.error(`\n❌ Build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  } finally {
    // 恢复源文件
    restoreFiles();
  }
}

function showHelp(): void {
  console.log(`
🏗️  Jixo Proxy Build Script v${VERSION}

Usage:
  bun run build.ts <command> [options]

Commands:
  binary              Build standalone executable
  help                Show this help message

Binary Options:
  --all               Build for all supported platforms
  --target=<name>     Build for specific platform
                      Supported: ${BUILD_TARGETS.map((t) => t.name).join(", ")}

Examples:
  bun run build.ts binary                     # Build for current platform
  bun run build.ts binary --all               # Build for all platforms
  bun run build.ts binary --target=linux-x64  # Build for Linux x64

Supported Platforms:
${BUILD_TARGETS.map((t) => `  - ${t.name} (${t.bunTarget})`).join("\n")}
`);
}

// 解析命令行参数
const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  showHelp();
  process.exit(0);
}

if (command === "binary") {
  const allFlag = args.includes("--all");
  const targetArg = args.find((a) => a.startsWith("--target="));
  const targetName = targetArg?.split("=")[1];

  if (allFlag) {
    await buildAllBinaries();
  } else {
    await buildSingleBinary(targetName);
  }
} else {
  console.error(`Unknown command: ${command}`);
  showHelp();
  process.exit(1);
}
