## Super Simple Setup (for everyone)

1. Download or clone this project.
2. Open a terminal in the project folder.
3. Run:
  ```bash
  ./install.sh
  ```
4. Follow the prompts. When finished, open [http://localhost:3000](http://localhost:3000) in your browser.

If you see errors, make sure Node.js, ffmpeg, and ffprobe are installed. That's it!
# Project Description

This project helps you transcode Plex movies and videos to save drive space, reduce storage costs, and optimize your media library. Easier to use than Tdarr, it offers a web UI and CLI for batch auditing and transcoding. Scan, filter, and convert files to efficient codecs with clear feedback—same results as Tdarr, but faster and simpler for Plex users.

# Plex Video Transcoder & Auditor

Easily transcode your Plex movies and videos to save drive space and optimize your media library. This app is easier to use than Tdarr, but delivers the same results—scan, filter, and convert files with a simple web interface or CLI.

## Quick Start

1. **Install Requirements:**
  - Node.js 18+
  - `ffmpeg` and `ffprobe` installed and available in your PATH

2. **Start the Web UI:**
  ```bash
  npm run server
  ```
  Open [http://localhost:3000](http://localhost:3000) in your browser.

3. **Audit & Transcode:**
  - Pick a root folder (where your Plex media is stored)
  - Choose video/audio codecs and settings
  - Run an audit to see which files match your criteria
  - Select files and transcode them to save space
  - Optionally, delete originals after transcoding

## Command Line Usage

**Audit videos:**
```bash
npm run audit -- --root /path/to/media --video-codec hevc --video-bitrate 6000k --audio-codec ac3 --audio-channels 6
```

**Generate smoke-test fixtures:**
```bash
npm run smoke-test -- --out ./smoke-fixtures
```

## Features

- User-friendly web interface (Express + Bootstrap)
- Batch audit and transcode for Plex libraries
- Folder picker and codec dropdowns (auto-detected from ffmpeg)
- Customizable bitrate and channel rules
- Select-all and batch operations
- Delete original files after transcode (optional)
- Dark theme for comfortable viewing
- CLI tools for advanced users

## Troubleshooting

- Make sure `ffmpeg` and `ffprobe` are installed and in your PATH
- Use Node.js 18 or newer
- If you see errors, check permissions on your media folders
- For help, open an issue or ask in discussions

## Project Structure

- `server.js` - Express app and static hosting
- `routes/` - API endpoints
- `controllers/` - Request handlers
- `services/` - Core logic (audit, options)
- `public/` - Web UI (HTML, JS, CSS)

---
Transcode your Plex library, save space, and enjoy a simpler workflow than Tdarr!
- Video bitrate numeric input with `k` units
- Audio channels typical dropdown (`Any`, `1`, `2`, `6`, `8`)
- Rule operators for bitrate/channels: `>=` (minimum), `<=` (maximum), `=` (exact/approx)
