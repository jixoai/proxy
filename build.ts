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

// 前端构建输出目录
const FRONTEND_BUILD_DIR = path.join(process.cwd(), ".build-frontend");
const FRONTEND_ENTRY = path.join(process.cwd(), "src", "viewer.html");
// Worker 构建输出目录
const WORKER_BUILD_DIR = path.join(process.cwd(), ".build-worker");
const WORKER_ENTRY = path.join(process.cwd(), "src", "proxy-server.ts");

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
 * 预编译 Worker 脚本
 * 将 proxy-server.ts 编译为独立的 JS 文件，供打包模式使用
 */
async function buildWorker(): Promise<void> {
  console.log("  Building proxy-server worker...");

  // 清理并创建 Worker 构建目录
  if (fs.existsSync(WORKER_BUILD_DIR)) {
    fs.rmSync(WORKER_BUILD_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(WORKER_BUILD_DIR, { recursive: true });

  // 使用 Bun bundler 编译 Worker
  const result = await Bun.build({
    entrypoints: [WORKER_ENTRY],
    outdir: WORKER_BUILD_DIR,
    target: "bun",
    minify: true,
    // 编译为独立的单文件，内联所有依赖
    // external 只排除 Node.js 内置模块
  });

  if (!result.success) {
    console.error("Worker build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Worker build failed");
  }

  // 读取生成的文件
  const files = fs.readdirSync(WORKER_BUILD_DIR);
  const jsFile = files.find(f => f.endsWith(".js"));

  if (!jsFile) {
    throw new Error("Worker build missing JS file");
  }

  const jsContent = fs.readFileSync(path.join(WORKER_BUILD_DIR, jsFile), "utf-8");

  // 生成嵌入模块
  const moduleContent = `/**
 * 预编译的 proxy-server Worker 脚本（由 build.ts 自动生成）
 * 请勿手动编辑此文件
 */

export const BUNDLED_PROXY_SERVER_JS = ${JSON.stringify(jsContent)};
`;

  fs.writeFileSync(
    path.join(WORKER_BUILD_DIR, "bundled-proxy-server.ts"),
    moduleContent
  );

  console.log("  Proxy-server worker built and bundled successfully");
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

  const args = [
    "bun", "build",
    ENTRY_FILE,
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
  await buildWorker();

  const results: Array<{ target: string; file: string; size: string; status: string }> = [];
  const start = performance.now();

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
  await buildWorker();

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
