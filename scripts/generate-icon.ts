#!/usr/bin/env bun
/**
 * Generate Windows icon from SVG
 *
 * Usage: bun run scripts/generate-icon.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
// @ts-expect-error - to-ico has no type declarations
import toIco from "to-ico";
import { Resvg } from "@resvg/resvg-js";

const SVG_PATH = path.join(process.cwd(), "src", "logo.svg");
const ICO_PATH = path.join(process.cwd(), "assets", "icon.ico");
const SIZES = [256, 128, 64, 48, 32, 16];

async function generateIcon() {
  console.log("Generating Windows icon from logo.svg...\n");

  // Read SVG
  const svgContent = fs.readFileSync(SVG_PATH, "utf-8");

  // Convert SVG to PNG at largest size first using resvg
  const resvg = new Resvg(svgContent, {
    fitTo: {
      mode: "width",
      value: 256,
    },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  // Generate PNGs at different sizes
  const pngBuffers: Buffer[] = [];

  for (const size of SIZES) {
    console.log(`  Generating ${size}x${size}...`);
    const resized = await sharp(pngBuffer)
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    pngBuffers.push(resized);
  }

  // Convert to ICO
  console.log("\n  Creating ICO file...");
  const icoBuffer = await toIco(pngBuffers);

  // Ensure assets directory exists
  fs.mkdirSync(path.dirname(ICO_PATH), { recursive: true });

  // Write ICO file
  fs.writeFileSync(ICO_PATH, icoBuffer);

  const stats = fs.statSync(ICO_PATH);
  console.log(`\nDone! Icon saved to: ${ICO_PATH}`);
  console.log(`Size: ${(stats.size / 1024).toFixed(2)} KB`);
}

generateIcon().catch(console.error);
