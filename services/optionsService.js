import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

let codecCache = null;

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

  const output = await runCommand('ffmpeg', ['-hide_banner', '-codecs']);
  codecCache = parseCodecOutput(output);
  return codecCache;
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
