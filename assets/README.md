# Assets

This directory contains application assets for building platform-specific binaries.

## Windows Icon (icon.ico)

The Windows executable requires an `.ico` file for the application icon.

### How to generate icon.ico from logo.svg:

**Option 1: Using ImageMagick (recommended)**

```bash
# Install ImageMagick if not already installed
# macOS: brew install imagemagick
# Ubuntu: sudo apt install imagemagick

# Convert SVG to ICO with multiple sizes
convert -background transparent src/logo.svg -define icon:auto-resize=256,128,64,48,32,16 assets/icon.ico
```

**Option 2: Using online converters**

1. Visit https://convertio.co/svg-ico/ or https://cloudconvert.com/svg-to-ico
2. Upload `src/logo.svg`
3. Configure output to include sizes: 256x256, 128x128, 64x64, 48x48, 32x32, 16x16
4. Download and save as `assets/icon.ico`

**Option 3: Using GIMP**

1. Open `src/logo.svg` in GIMP
2. Export as `.ico` with multiple sizes

### Required file

Place your generated icon at: `assets/icon.ico`

The build script will automatically use this icon for Windows builds if it exists.
