# Packaging for Idiot-Proof Distribution

To make this Node.js project run on Windows, Linux, and macOS without requiring users to install Node.js separately, you can package it as a standalone executable using tools like:

- **pkg** (https://github.com/vercel/pkg): Packages Node.js apps into executables for all platforms.
- **nexe** (https://github.com/nexe/nexe): Similar, builds a single binary.

## How to Package

1. Install pkg globally:
   ```bash
   npm install -g pkg
   ```

2. Build executables for all platforms:
   ```bash
   pkg . --targets node18-win-x64,node18-macos-x64,node18-linux-x64
   ```

3. Distribute the resulting .exe, .app, or binary files. Users just run the file—no Node.js install needed!

## Notes
- ffmpeg and ffprobe must still be installed separately (not bundled).
- For full automation, add ffmpeg binaries or check for them in your installer.

---
See pkg or nexe docs for advanced options.
