#!/usr/bin/env bun
/**
 * Release script for publishing versions
 *
 * Usage:
 *   bun release              # Interactive mode
 *   bun release patch        # Bump patch version
 *   bun release minor        # Bump minor version
 *   bun release major        # Bump major version
 *   bun release --version=1.2.3
 *   bun release -v 1.2.3
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message: string) {
  console.log(message);
}

function success(message: string) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function error(message: string) {
  console.error(`${colors.red}✗${colors.reset} ${message}`);
}

function info(message: string) {
  console.log(`${colors.cyan}ℹ${colors.reset} ${message}`);
}

function warn(message: string) {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function header(message: string) {
  console.log(`\n${colors.bold}${colors.blue}${message}${colors.reset}\n`);
}

// Execute shell command and return output
async function exec(
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// Execute and stream output
async function execStream(command: string): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

// Prompt user for input
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Prompt for yes/no
async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await prompt(`${question} ${suffix} `);

  if (answer === "") {
    return defaultYes;
  }

  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

// Parse semantic version
function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;

  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: parseInt(match[3]!, 10),
  };
}

// Format version string
function formatVersion(v: { major: number; minor: number; patch: number }): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// Bump version
function bumpVersion(
  current: string,
  type: "major" | "minor" | "patch"
): string {
  const v = parseVersion(current);
  if (!v) {
    throw new Error(`Invalid version format: ${current}`);
  }

  switch (type) {
    case "major":
      return formatVersion({ major: v.major + 1, minor: 0, patch: 0 });
    case "minor":
      return formatVersion({ major: v.major, minor: v.minor + 1, patch: 0 });
    case "patch":
      return formatVersion({ major: v.major, minor: v.minor, patch: v.patch + 1 });
  }
}

// Check if git working directory is clean
async function isGitClean(): Promise<boolean> {
  const { stdout } = await exec("git status --porcelain");
  return stdout === "";
}

// Get current git branch
async function getCurrentBranch(): Promise<string> {
  const { stdout } = await exec("git branch --show-current");
  return stdout;
}

// Read package.json
function readPackageJson(): { version: string; [key: string]: unknown } {
  const pkgPath = path.join(process.cwd(), "package.json");
  const content = fs.readFileSync(pkgPath, "utf-8");
  return JSON.parse(content);
}

// Write package.json
function writePackageJson(pkg: Record<string, unknown>): void {
  const pkgPath = path.join(process.cwd(), "package.json");
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

// Interactive version selection
async function selectVersion(currentVersion: string): Promise<string | null> {
  header("Release Version Selection");

  log(`Current version: ${colors.cyan}${currentVersion}${colors.reset}\n`);

  const patchVersion = bumpVersion(currentVersion, "patch");
  const minorVersion = bumpVersion(currentVersion, "minor");
  const majorVersion = bumpVersion(currentVersion, "major");

  log("Select version type:\n");
  log(`  ${colors.bold}1)${colors.reset} patch  -> ${colors.green}${patchVersion}${colors.reset}`);
  log(`  ${colors.bold}2)${colors.reset} minor  -> ${colors.green}${minorVersion}${colors.reset}`);
  log(`  ${colors.bold}3)${colors.reset} major  -> ${colors.green}${majorVersion}${colors.reset}`);
  log(`  ${colors.bold}4)${colors.reset} custom -> enter version manually`);
  log(`  ${colors.bold}q)${colors.reset} quit\n`);

  const choice = await prompt("Your choice [1]: ");

  switch (choice.toLowerCase()) {
    case "":
    case "1":
    case "patch":
      return patchVersion;
    case "2":
    case "minor":
      return minorVersion;
    case "3":
    case "major":
      return majorVersion;
    case "4":
    case "custom": {
      const customVersion = await prompt("Enter version (e.g., 1.2.3): ");
      if (!parseVersion(customVersion)) {
        error(`Invalid version format: ${customVersion}`);
        return null;
      }
      return customVersion;
    }
    case "q":
    case "quit":
      return null;
    default:
      error(`Invalid choice: ${choice}`);
      return null;
  }
}

// Main release function
async function release(targetVersion: string, skipPush = false): Promise<void> {
  const pkg = readPackageJson();
  const currentVersion = pkg.version as string;

  header("Release Process");

  log(`  Current version: ${colors.dim}${currentVersion}${colors.reset}`);
  log(`  Target version:  ${colors.green}${targetVersion}${colors.reset}\n`);

  // Step 1: Verify git is clean
  info("Checking git working directory...");
  if (!(await isGitClean())) {
    error("Git working directory is not clean. Please commit or stash your changes first.");
    process.exit(1);
  }
  success("Git working directory is clean");

  // Show current branch
  const branch = await getCurrentBranch();
  info(`Current branch: ${branch}`);

  // Step 2: Update package.json
  info("Updating package.json...");
  pkg.version = targetVersion;
  writePackageJson(pkg);
  success(`Updated version to ${targetVersion}`);

  // Step 3: Stage package.json
  info("Staging package.json...");
  const stageResult = await exec("git add package.json");
  if (stageResult.exitCode !== 0) {
    error(`Failed to stage package.json: ${stageResult.stderr}`);
    process.exit(1);
  }
  success("Staged package.json");

  // Step 4: Create commit
  const commitMessage = `chore: release v${targetVersion}`;
  info(`Creating commit: "${commitMessage}"...`);
  const commitResult = await exec(`git commit -m "${commitMessage}"`);
  if (commitResult.exitCode !== 0) {
    error(`Failed to create commit: ${commitResult.stderr}`);
    process.exit(1);
  }
  success("Created commit");

  // Step 5: Create tag
  const tagName = `v${targetVersion}`;
  info(`Creating tag: ${tagName}...`);
  const tagResult = await exec(`git tag ${tagName}`);
  if (tagResult.exitCode !== 0) {
    error(`Failed to create tag: ${tagResult.stderr}`);
    process.exit(1);
  }
  success(`Created tag ${tagName}`);

  // Step 6: Push (with confirmation)
  if (!skipPush) {
    log("");
    const shouldPush = await confirm("Push commit and tag to remote?");

    if (shouldPush) {
      info("Pushing to remote...");
      const pushResult = await execStream("git push && git push --tags");
      if (pushResult !== 0) {
        error("Failed to push to remote");
        warn("You can push manually with: git push && git push --tags");
        process.exit(1);
      }
      success("Pushed to remote");
    } else {
      warn("Skipped push. You can push manually with:");
      log(`  ${colors.dim}git push && git push --tags${colors.reset}`);
    }
  }

  // Done
  header("Release Complete!");
  log(`  Version ${colors.green}v${targetVersion}${colors.reset} has been released.\n`);
}

// Parse command line arguments
function parseArgs(): {
  version?: string;
  type?: "major" | "minor" | "patch";
  help?: boolean;
} {
  const args = process.argv.slice(2);
  const result: ReturnType<typeof parseArgs> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg?.startsWith("--version=")) {
      result.version = arg.split("=")[1];
    } else if (arg === "--version" || arg === "-v") {
      result.version = args[++i];
    } else if (arg === "patch" || arg === "minor" || arg === "major") {
      result.type = arg;
    }
  }

  return result;
}

function printHelp(): void {
  log(`
${colors.bold}Release Script${colors.reset}

${colors.bold}Usage:${colors.reset}
  bun release              Interactive mode
  bun release patch        Bump patch version (0.1.0 -> 0.1.1)
  bun release minor        Bump minor version (0.1.0 -> 0.2.0)
  bun release major        Bump major version (0.1.0 -> 1.0.0)
  bun release --version=X  Release specific version X
  bun release -v X         Release specific version X

${colors.bold}Options:${colors.reset}
  -h, --help       Show this help message
  -v, --version    Specify exact version to release

${colors.bold}Examples:${colors.reset}
  bun release patch
  bun release --version=1.2.3
  bun release -v 2.0.0
`);
}

// Main entry point
async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const pkg = readPackageJson();
  const currentVersion = pkg.version as string;

  let targetVersion: string | null = null;

  if (args.version) {
    // Explicit version specified
    if (!parseVersion(args.version)) {
      error(`Invalid version format: ${args.version}`);
      log("Version must be in semver format (e.g., 1.2.3)");
      process.exit(1);
    }
    targetVersion = args.version;
  } else if (args.type) {
    // Version type specified (patch/minor/major)
    targetVersion = bumpVersion(currentVersion, args.type);
  } else {
    // Interactive mode
    targetVersion = await selectVersion(currentVersion);
    if (!targetVersion) {
      log("\nRelease cancelled.");
      process.exit(0);
    }
  }

  // Confirm before proceeding
  if (!args.version && !args.type) {
    // Only confirm in interactive mode (already selected version)
    const shouldProceed = await confirm(
      `\nRelease version ${colors.green}${targetVersion}${colors.reset}?`
    );
    if (!shouldProceed) {
      log("\nRelease cancelled.");
      process.exit(0);
    }
  }

  await release(targetVersion);
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});
