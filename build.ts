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
const WORKER_FILES = ["proxy-server.ts"].map((file) => path.join(process.cwd(), "src", file));
const WINDOWS_ICON = path.join(process.cwd(), "assets", "icon.ico");

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

  // Bun 原生支持多入口编译，Worker 文件会被正确处理
  await Bun.build({
    entrypoints: [ENTRY_FILE, ...WORKER_FILES],
    target: "bun",
    outdir: DIST_DIR,
    minify: true,
    plugins: [tailwindPlugin],
    compile: {
      target: targetName ? `bun-${targetName}` : undefined,
      outfile: outfile,
      ...(target.name === "windows-x64"
        ? {
            windows: {
              icon: WINDOWS_ICON,
              title: "Jixo Proxy",
              description: "Visual Proxy Server",
              version: `${VERSION}.0`,
            },
          }
        : {}),
    },
  }).catch((error) => {
    console.error(`\n❌ Build failed:`, error);
    process.exit(1);
  });

  const stats = fs.statSync(outfile);
  return { file: outfile, size: stats.size };
}

async function buildAllBinaries(): Promise<void> {
  console.log(`\n🏗️  Building ${NAME} v${VERSION} for all platforms...\n`);

  // 确保 dist 目录存在
  fs.mkdirSync(DIST_DIR, { recursive: true });

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
