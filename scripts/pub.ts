#!/usr/bin/env bun
/**
 * 简单的包发布脚本
 *
 * 用法:
 *   bun scripts/pub.ts                    # 交互式选择
 *   bun scripts/pub.ts --all              # 发布所有包
 *   bun scripts/pub.ts proxy-plugin       # 发布指定包
 *   bun scripts/pub.ts --bump patch       # 指定版本类型 (patch/minor/major)
 *   bun scripts/pub.ts --dry-run          # 干跑模式，不实际发布
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const PACKAGES_DIR = path.join(import.meta.dirname, "../packages");

interface PackageInfo {
  name: string;
  dirName: string;
  version: string;
  path: string;
  packageJsonPath: string;
}

type BumpType = "patch" | "minor" | "major";

function getPackages(): PackageInfo[] {
  const entries = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true });
  const packages: PackageInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(PACKAGES_DIR, entry.name, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    packages.push({
      name: pkgJson.name,
      dirName: entry.name,
      version: pkgJson.version,
      path: path.join(PACKAGES_DIR, entry.name),
      packageJsonPath: pkgJsonPath,
    });
  }

  return packages;
}

function bumpVersion(version: string, type: BumpType): string {
  const parts = version.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

function updatePackageVersion(pkg: PackageInfo, newVersion: string): void {
  const pkgJson = JSON.parse(fs.readFileSync(pkg.packageJsonPath, "utf-8"));
  pkgJson.version = newVersion;
  fs.writeFileSync(pkg.packageJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
}

function promptSelect(message: string, options: string[]): string {
  console.log(`\n${message}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));

  while (true) {
    const input = prompt("\n选择 (输入数字):");
    if (input === null) {
      console.log("\n已取消");
      process.exit(0);
    }
    const idx = parseInt(input.trim(), 10) - 1;
    if (idx >= 0 && idx < options.length) {
      return options[idx]!;
    }
    console.log("无效选择，请重新输入");
  }
}

function promptConfirm(message: string): boolean {
  while (true) {
    const input = prompt(`${message} (y/n):`);
    if (input === null) {
      return false;
    }
    const answer = input.trim().toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("请输入 y 或 n");
  }
}

async function publish(pkg: PackageInfo, dryRun: boolean): Promise<boolean> {
  console.log(`\n📦 发布 ${pkg.name}@${pkg.version}...`);

  if (dryRun) {
    console.log("   [干跑模式] 跳过实际发布");
    return true;
  }

  const proc = Bun.spawn(["bun", "publish", "--access", "public"], {
    cwd: pkg.path,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`   ❌ 发布失败 (exit code: ${exitCode})`);
    return false;
  }

  console.log(`   ✅ 发布成功`);
  return true;
}

async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      bump: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (args.values.help) {
    console.log(`
用法: bun scripts/pub.ts [options] [package-name]

选项:
  --all         发布所有包
  --bump TYPE   版本类型: patch, minor, major
  --dry-run     干跑模式，不实际发布
  -h, --help    显示帮助

示例:
  bun scripts/pub.ts                     # 交互式选择
  bun scripts/pub.ts proxy-plugin        # 发布指定包
  bun scripts/pub.ts --all --bump patch  # 发布所有包，版本+patch
`);
    process.exit(0);
  }

  const packages = getPackages();
  if (packages.length === 0) {
    console.error("❌ 没有找到任何包");
    process.exit(1);
  }

  console.log("📋 发现以下包:\n");
  packages.forEach((pkg) => {
    console.log(`   ${pkg.name} @ ${pkg.version}`);
  });

  const dryRun = args.values["dry-run"] ?? false;
  if (dryRun) {
    console.log("\n⚠️  干跑模式 - 不会实际发布");
  }

  // 确定要发布的包
  let selectedPackages: PackageInfo[];

  if (args.values.all) {
    selectedPackages = packages;
  } else if (args.positionals.length > 0) {
    const targetName = args.positionals[0];
    const found = packages.filter(
      (p) => p.dirName === targetName || p.name === targetName || p.name === `@jixo/${targetName}`
    );
    if (found.length === 0) {
      console.error(`\n❌ 找不到包: ${targetName}`);
      process.exit(1);
    }
    selectedPackages = found;
  } else {
    // 交互式选择
    const choice = promptSelect(
      "选择要发布的包:",
      [...packages.map((p) => `${p.name} @ ${p.version}`), "全部发布"]
    );

    if (choice === "全部发布") {
      selectedPackages = packages;
    } else {
      const pkg = packages.find((p) => choice.startsWith(p.name));
      if (!pkg) {
        console.error("❌ 选择无效");
        process.exit(1);
      }
      selectedPackages = [pkg];
    }
  }

  // 确定版本类型
  let bumpType: BumpType | null = null;

  if (args.values.bump) {
    const type = args.values.bump as BumpType;
    if (!["patch", "minor", "major"].includes(type)) {
      console.error(`❌ 无效的版本类型: ${type}`);
      process.exit(1);
    }
    bumpType = type;
  } else {
    const choice = promptSelect("选择版本更新类型:", ["patch (补丁)", "minor (次版本)", "major (主版本)", "不更新版本"]);

    if (choice.startsWith("patch")) bumpType = "patch";
    else if (choice.startsWith("minor")) bumpType = "minor";
    else if (choice.startsWith("major")) bumpType = "major";
  }

  // 显示将要执行的操作
  console.log("\n📝 将执行以下操作:\n");
  for (const pkg of selectedPackages) {
    const newVersion = bumpType ? bumpVersion(pkg.version, bumpType) : pkg.version;
    if (bumpType) {
      console.log(`   ${pkg.name}: ${pkg.version} → ${newVersion}`);
    } else {
      console.log(`   ${pkg.name}: ${pkg.version}`);
    }
  }

  const confirmed = promptConfirm("\n确认发布?");
  if (!confirmed) {
    console.log("已取消");
    process.exit(0);
  }

  // 更新版本并发布
  let successCount = 0;
  let failCount = 0;

  for (const pkg of selectedPackages) {
    if (bumpType) {
      const newVersion = bumpVersion(pkg.version, bumpType);
      console.log(`\n📝 更新 ${pkg.name} 版本: ${pkg.version} → ${newVersion}`);
      if (!dryRun) {
        updatePackageVersion(pkg, newVersion);
        pkg.version = newVersion;
      }
    }

    const success = await publish(pkg, dryRun);
    if (success) successCount++;
    else failCount++;
  }

  console.log(`\n🎉 完成! 成功: ${successCount}, 失败: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
