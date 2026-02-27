# Plex Video Transcoder & Auditor

Transcode Plex/media libraries with a simple web UI. The project audits files against codec/bitrate/channel rules, then batch transcodes selected files while streaming live progress.

## Super Simple Setup

1. Download or clone this project.
2. Open a terminal in the project folder.
3. Run:
   ```bash
   ./install.sh
   ```
4. Follow the prompts, then open http://localhost:3000.

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

See [PACKAGING.md](PACKAGING.md) for distribution options.

## Project Structure

- `server.js` — Express app and static hosting
- `routes/` — API routes
- `controllers/` — request handlers/orchestration
- `services/` — reusable transcode/audit services
- `public/` — web UI assets
