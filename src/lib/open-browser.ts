/**
 * Open browser with tab reuse support.
 * On macOS, tries to reuse existing Chrome/Chromium tabs using AppleScript.
 * Based on react-dev-utils/openBrowser.js
 */

import { execSync } from "node:child_process";
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

/**
 * Try to open URL in an existing Chromium browser tab on macOS.
 * Returns true if successful, false otherwise.
 */
function tryOpenChromiumWithAppleScript(url: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }

  for (const browser of SUPPORTED_CHROMIUM_BROWSERS) {
    try {
      // Check if browser is running
      execSync(`ps cax | grep "${browser}"`, { stdio: "ignore" });

      // Try to reuse existing tab with AppleScript
      const scriptPath = path.join(import.meta.dirname, "openChrome.applescript");
      execSync(`osascript "${scriptPath}" "${encodeURI(url)}" "${browser}"`, {
        stdio: "ignore",
      });

      return true;
    } catch {
      // Browser not running or AppleScript failed, try next
    }
  }

  return false;
}

/**
 * Open browser with the given URL.
 * On macOS with Chromium browsers, tries to reuse existing tab.
 * Falls back to opening a new tab/window if reuse is not possible.
 */
export function openBrowser(url: string): void {
  // Try to reuse existing tab on macOS
  if (tryOpenChromiumWithAppleScript(url)) {
    return;
  }

  // Fallback: open new tab (always creates new tab)
  open(url);
}
