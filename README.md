# Plex Video Transcoder & Auditor

[![Version](https://img.shields.io/github/package-json/v/harryhax/node_ffmpeg_transcoder?label=Version)](https://github.com/harryhax/node_ffmpeg_transcoder)
[![License](https://img.shields.io/github/license/harryhax/node_ffmpeg_transcoder)](https://github.com/harryhax/node_ffmpeg_transcoder/blob/main/LICENSE)
[![Stars](https://img.shields.io/github/stars/harryhax/node_ffmpeg_transcoder?style=social)](https://github.com/harryhax/node_ffmpeg_transcoder/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/harryhax/node_ffmpeg_transcoder)](https://github.com/harryhax/node_ffmpeg_transcoder/commits/main)
[![Discord](https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/HMCNq2bEE5)

Transcode Plex/media libraries with a simple web UI. The project audits files against codec/bitrate/channel rules, then batch transcodes selected files while streaming live progress.

## Run server.js directly (Node + FFmpeg already installed)

If you already have Node.js and ffmpeg/ffprobe installed:

1. Clone this repository.
2. Open a terminal in the project folder.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   node server.js
   ```
5. Open http://localhost:3000.

## Super Simple Setup

1. Download or clone this project.
2. Open a terminal in the project folder.
3. Run:
   ```bash
   ./install/install.sh
   ```
4. Follow the prompts, then open http://localhost:3000.

### Windows setup

Run this in PowerShell from the project folder:

```powershell
.\install\install.ps1
```

## Requirements

- Node.js 18+
- `ffmpeg` and `ffprobe`

You can either:
- keep `ffmpeg`/`ffprobe` available in your system PATH, or
- set folder overrides in Settings (folder path only, not the executable file path).

## Run the App

```bash
npm run server
```

Then open http://localhost:3000.

### macOS no-sleep mode (recommended for long transcodes)

```bash
npm run server:no-sleep
```

## Web UI Workflow

1. Pick a root folder.
2. Choose codec/bitrate/channel rules.
3. Run audit.
4. Select matching files.
5. Run transcode.

The UI includes:
- live per-file and overall transcode progress
- transcode cancel support
- per-file outcome highlighting
- optional per-file `.log` output
- top-level critical error banner when required tools are missing

## Optional Utility

Smoke test fixture generation:

```bash
npm run smoke-test -- --out ./smoke-fixtures
```

## Troubleshooting

- Run `npm run check` to validate project JS syntax.
- If tool checks fail, install `ffmpeg`/`ffprobe` or set folder overrides in Settings.
- Verify read/write permissions for media folders and transcode target locations.

## Packaging

Packaging is on hold for now. Current supported usage is to clone the repo and run it as a standard Node.js project.

## License and Liability

This project is licensed under the MIT License. See [LICENSE](LICENSE).

Copyright (c) 2026 Harry Scanlan.

It is provided "AS IS", without warranty of any kind, and the author is not liable for any claim, damages, or other liability arising from use of this software.

## Project Structure

- `server.js` — Express app and static hosting
- `routes/` — API routes
- `controllers/` — request handlers/orchestration
- `services/` — reusable transcode/audit services
- `public/` — web UI assets
