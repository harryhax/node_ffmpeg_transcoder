import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

let codecCache = null;
const toolPathOverrides = {
  ffmpegDir: '',
  ffprobeDir: ''
};

function normalizeDirectoryInput(value) {
  if (value === undefined || value === null) {
    return '';
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return '';
  }
  return path.resolve(trimmed);
}

function resolveExecutablePath(dirOverride, executableName) {
  if (!dirOverride) {
    return executableName;
  }
  return path.join(dirOverride, executableName);
}

export function getToolPathOverrides() {
  return {
    ffmpegDir: toolPathOverrides.ffmpegDir,
    ffprobeDir: toolPathOverrides.ffprobeDir
  };
}

export function setToolPathOverrides({ ffmpegDir, ffprobeDir } = {}) {
  const nextFfmpegDir = normalizeDirectoryInput(ffmpegDir);
  const nextFfprobeDir = normalizeDirectoryInput(ffprobeDir);

  const changed = nextFfmpegDir !== toolPathOverrides.ffmpegDir || nextFfprobeDir !== toolPathOverrides.ffprobeDir;
  toolPathOverrides.ffmpegDir = nextFfmpegDir;
  toolPathOverrides.ffprobeDir = nextFfprobeDir;
  if (changed) {
    codecCache = null;
  }
}

export function getFfmpegCommand() {
  return resolveExecutablePath(toolPathOverrides.ffmpegDir, 'ffmpeg');
}

export function getFfprobeCommand() {
  return resolveExecutablePath(toolPathOverrides.ffprobeDir, 'ffprobe');
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exit code ${code}: ${stderr.trim() || 'unknown error'}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseCodecOutput(output) {
  const videoCodecs = new Set();
  const audioCodecs = new Set();

  const encoderRegex = /encoders: ([^\)]+)\)/i;
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s([D\.])([E\.])([VASDT\.])[A-Z\.]{3}\s+([^\s]+)\s+/i);
    if (!match) {
      continue;
    }

    const canEncode = match[2] === 'E';
    const type = match[3];
    const codecName = match[4];

    if (!canEncode || !codecName) {
      continue;
    }

    // Extract encoder names if present
    let encoders = [];
    const encoderMatch = line.match(encoderRegex);
    if (encoderMatch) {
      encoders = encoderMatch[1].split(/\s+/).filter(Boolean);
    }

    if (type === 'V') {
      videoCodecs.add(codecName);
      encoders.forEach(e => videoCodecs.add(e));
    } else if (type === 'A') {
      audioCodecs.add(codecName);
      encoders.forEach(e => audioCodecs.add(e));
    }
  }

  return {
    videoCodecs: [...videoCodecs].sort((a, b) => a.localeCompare(b)),
    audioCodecs: [...audioCodecs].sort((a, b) => a.localeCompare(b))
  };
}

export async function getCodecOptions() {
  if (codecCache) {
    return codecCache;
  }

  const output = await runCommand(getFfmpegCommand(), ['-hide_banner', '-codecs']);
  codecCache = parseCodecOutput(output);
  return codecCache;
}

async function checkTool(command, args = ['-version']) {
  try {
    await runCommand(command, args);
    return { ok: true, command };
  } catch (error) {
    return { ok: false, command, error: error.message };
  }
}

export async function getToolHealth() {
  const ffmpegCommand = getFfmpegCommand();
  const ffprobeCommand = getFfprobeCommand();
  const ffmpeg = await checkTool(ffmpegCommand, ['-version']);
  const ffprobe = await checkTool(ffprobeCommand, ['-version']);

  return {
    ffmpeg,
    ffprobe,
    allOk: ffmpeg.ok && ffprobe.ok,
    usingSystemDefaults: !toolPathOverrides.ffmpegDir && !toolPathOverrides.ffprobeDir,
    overrides: getToolPathOverrides()
  };
}

export async function listDirectories(base = '.', maxDepth = 3, maxResults = 250) {
  const root = path.resolve(base);
  const queue = [{ dir: root, depth: 0 }];
  const found = [];

  while (queue.length && found.length < maxResults) {
    const current = queue.shift();
    found.push(current.dir);

    if (current.depth >= maxDepth) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }

      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return found.sort((a, b) => a.localeCompare(b));
}
