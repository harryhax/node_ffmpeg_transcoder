import path from 'path';
import { spawn } from 'child_process';
import { getFfprobeCommand } from './optionsService.js';

function isWebmCompatible(videoCodec, audioCodec) {
  const normalizedVideo = (videoCodec || '').toLowerCase();
  const normalizedAudio = (audioCodec || '').toLowerCase();

  const videoOk =
    !normalizedVideo ||
    normalizedVideo.includes('vp8') ||
    normalizedVideo.includes('vp9') ||
    normalizedVideo.includes('av1');

  const audioOk =
    !normalizedAudio ||
    normalizedAudio.includes('opus') ||
    normalizedAudio.includes('vorbis');

  return videoOk && audioOk;
}

function parseTimestampToSeconds(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const matched = value.trim().match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!matched) {
    return null;
  }

  const hours = Number.parseInt(matched[1], 10);
  const minutes = Number.parseInt(matched[2], 10);
  const seconds = Number.parseFloat(matched[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  return (hours * 3600) + (minutes * 60) + seconds;
}

export function buildOutputPath(inputPath, opts = {}) {
  const inputExt = path.extname(inputPath).toLowerCase();
  const ext = inputExt === '.webm' && !isWebmCompatible(opts.videoCodec, opts.audioCodec)
    ? '.mkv'
    : inputExt;
  const base = path.basename(inputPath, inputExt);
  const dir = path.dirname(inputPath);
  return path.join(dir, `${base}.transcoded${ext}`);
}

export function buildLogPathFromOutput(outputPath) {
  const ext = path.extname(outputPath);
  const base = path.basename(outputPath, ext);
  const dir = path.dirname(outputPath);
  return path.join(dir, `${base}.log`);
}

export function buildFailLogPathFromOutput(outputPath) {
  const ext = path.extname(outputPath);
  const base = path.basename(outputPath, ext);
  const dir = path.dirname(outputPath);
  return path.join(dir, `${base}.fail.log`);
}

export function extractProgressFromChunk(chunkText) {
  if (!chunkText) {
    return null;
  }

  const timeMatches = [...chunkText.matchAll(/time=(\d+:\d{2}:\d{2}(?:\.\d+)?)/g)];
  if (!timeMatches.length) {
    return null;
  }

  const speedMatches = [...chunkText.matchAll(/speed=\s*([0-9.]+)x/g)];
  const latestTime = timeMatches[timeMatches.length - 1][1];
  const latestSpeed = speedMatches.length ? Number.parseFloat(speedMatches[speedMatches.length - 1][1]) : null;

  return {
    processedSeconds: parseTimestampToSeconds(latestTime),
    speed: Number.isFinite(latestSpeed) && latestSpeed > 0 ? latestSpeed : null
  };
}

export function runCommand(command, args) {
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
      resolve({ code, stdout, stderr });
    });
  });
}

export function runFfprobeDuration(filePath) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath];
    const ffprobeCommand = getFfprobeCommand();

    const child = spawn(ffprobeCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', () => {
      resolve(null);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      try {
        const parsed = JSON.parse(stdout || '{}');
        const candidates = [];

        const formatDuration = Number.parseFloat(parsed?.format?.duration);
        if (Number.isFinite(formatDuration) && formatDuration > 0) {
          candidates.push(formatDuration);
        }

        const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
        for (const stream of streams) {
          const streamDuration = Number.parseFloat(stream?.duration);
          if (Number.isFinite(streamDuration) && streamDuration > 0) {
            candidates.push(streamDuration);
          }

          const tagDuration = stream?.tags?.DURATION;
          const tagSeconds = parseTimestampToSeconds(String(tagDuration || ''));
          if (Number.isFinite(tagSeconds) && tagSeconds > 0) {
            candidates.push(tagSeconds);
          }
        }

        if (!candidates.length) {
          resolve(null);
          return;
        }

        resolve(Math.max(...candidates));
      } catch {
        resolve(null);
      }
    });
  });
}