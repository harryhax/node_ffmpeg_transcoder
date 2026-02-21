#!/bin/bash
# Simple installer for Video Encoding Auditor & Plex Transcoder
# Usage: ./install.sh

set -e

# Check for Node.js
if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Please install Node.js 18+ and rerun this script."
  exit 1
fi

# Check for ffmpeg and ffprobe
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "ffmpeg and ffprobe are required. Please install them and rerun this script."
  exit 1
fi

# Install dependencies
npm install

# Start the server
npm run server

echo "\nApp is running! Open http://localhost:3000 in your browser."
