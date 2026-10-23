/**
 * Open browser with tab reuse support.
 * On macOS, tries to reuse existing Chrome/Chromium tabs using AppleScript.
 * Based on react-dev-utils/openBrowser.js
 */

import { execSync, spawn } from "node:child_process";
import * as path from "node:path";
import open from "open";

const SUPPORTED_CHROMIUM_BROWSERS = [
  "Google Chrome Canary",
  "Google Chrome Dev",
  "Google Chrome Beta",
  "Google Chrome",
  "Microsoft Edge",
  "Brave Browser",
  "Vivaldi",
  "Chromium",
];

// osascript 控制 Chrome 可能因 macOS 自动化权限未授予/弹窗未处理而无限挂起。
// 必须异步执行并带超时，否则会阻塞 Bun 主线程导致整个 HTTP 服务停摆。
const APPLESCRIPT_TIMEOUT_MS = 5_000;
const PROCESS_CHECK_TIMEOUT_MS = 3_000;

function isProcessRunning(name: string): boolean {
  try {
    execSync(`ps cax | grep "${name}"`, {
      stdio: "ignore",
      timeout: PROCESS_CHECK_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

function runAppleScriptWithTimeout(
  scriptPath: string,
  url: string,
  browser: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("osascript", [scriptPath, encodeURI(url), browser], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, APPLESCRIPT_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Try to open URL in an existing Chromium browser tab on macOS.
 * Resolves false if unavailable or timed out.
 */
async function tryOpenChromiumWithAppleScript(url: string): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  for (const browser of SUPPORTED_CHROMIUM_BROWSERS) {
    if (!isProcessRunning(browser)) continue;
    const scriptPath = path.join(import.meta.dirname, "openChrome.applescript");
    if (await runAppleScriptWithTimeout(scriptPath, url, browser)) {
      return true;
    }
  }

  return false;
}

/**
 * Open browser with the given URL.
 * On macOS with Chromium browsers, tries to reuse existing tab.
 * Falls back to opening a new tab/window if reuse is not possible.
 */
export async function openBrowser(url: string): Promise<void> {
  // Try to reuse existing tab on macOS
  if (await tryOpenChromiumWithAppleScript(url)) {
    return;
  }

  // Fallback: open new tab (always creates new tab)
  await open(url);
}
