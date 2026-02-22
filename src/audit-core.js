import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts'
]);

export function normalizeBitrateToBps(input) {
  if (!input) {
    return undefined;
  }

  const value = String(input).trim().toLowerCase();
  const matched = value.match(/^(\d+(?:\.\d+)?)([kmg])?$/);
  if (!matched) {
    throw new Error(`Invalid bitrate format: ${input}`);
  }

  const number = Number.parseFloat(matched[1]);
  const suffix = matched[2] || '';
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'g' ? 1_000_000_000 : 1;
  return Math.round(number * multiplier);
}

export function formatBps(bps) {
  if (!Number.isFinite(bps) || bps <= 0) {
    return 'unknown';
  }
  if (bps >= 1_000_000_000) return `${(bps / 1_000_000_000).toFixed(2)}G`;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)}M`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(2)}k`;
  return String(bps);
}

export function formatSize(bytes) {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / (1024 ** i);
  return `${value.toFixed(2)}${sizes[i]}`;
}

export async function collectVideoFiles(rootDir) {
  const files = [];
  const queue = [path.resolve(rootDir)];

  while (queue.length) {
    const dir = queue.pop();
    let entries;

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (VIDEO_EXTENSIONS.has(ext)) {
          try {
            const stat = await fs.stat(fullPath);
            files.push({
              path: fullPath,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs
            });
          } catch {
          }
        }
      }
    }
  }

  files.sort((a, b) => b.size - a.size);
  return files;
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath];
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';

    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start ffprobe: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exit code ${code}: ${err.trim() || 'unknown error'}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (error) {
        reject(new Error(`Unable to parse ffprobe JSON for ${filePath}: ${error.message}`));
      }
    });
  });
}

function pickBitrate(stream, format) {
  const streamBitrate = Number.parseInt(stream?.bit_rate, 10);
  if (Number.isFinite(streamBitrate) && streamBitrate > 0) {
    return streamBitrate;
  }
  const formatBitrate = Number.parseInt(format?.bit_rate, 10);
  if (Number.isFinite(formatBitrate) && formatBitrate > 0) {
    return formatBitrate;
  }
  return undefined;
}

function normalizeOperator(operator) {
  return operator === '>=' || operator === '<=' || operator === '=' ? operator : '=';
}

function compareNumber(actual, expected, operator, tolerance = 0) {
  if (operator === '>=') {
    return actual >= (expected - tolerance);
  }
  if (operator === '<=') {
    return actual <= (expected + tolerance);
  }
  return Math.abs(actual - expected) <= tolerance;
}

function normalizeVideoCodecForMatch(codec) {
  if (!codec) {
    return '';
  }

  const value = String(codec).trim().toLowerCase();

  if (value.includes('hevc') || value.includes('x265') || value === 'libx265') {
    return 'hevc';
  }

  if (
    value.includes('h264') ||
    value.includes('avc') ||
    value.includes('x264') ||
    value === 'libx264'
  ) {
    return 'h264';
  }

  return value;
}

function evaluateMatch(target, actual) {
  const mismatches = [];
  const checks = {
    videoCodec: null,
    videoBitrate: null,
    audioCodec: null,
    audioChannels: null
  };

  const normalizedTargetVideoCodec = normalizeVideoCodecForMatch(target.videoCodec);
  const normalizedActualVideoCodec = normalizeVideoCodecForMatch(actual.videoCodec);

  if (target.videoCodec && normalizedActualVideoCodec !== normalizedTargetVideoCodec) {
    checks.videoCodec = false;
    mismatches.push(`video codec expected=${target.videoCodec} actual=${actual.videoCodec || 'unknown'}`);
  } else if (target.videoCodec) {
    checks.videoCodec = true;
  }

  if (Number.isFinite(target.videoBitrate)) {
    const bitrateOperator = normalizeOperator(target.videoBitrateOp);
    if (!Number.isFinite(actual.videoBitrate)) {
      checks.videoBitrate = false;
      mismatches.push(`video bitrate rule ${bitrateOperator} ${formatBps(target.videoBitrate)} but actual bitrate is unknown`);
    } else {
      const tolerancePercent = Number.isFinite(target.videoBitrateTolerancePct)
        ? target.videoBitrateTolerancePct
        : 10;
      const tolerance = Math.round(target.videoBitrate * (tolerancePercent / 100));
      const passed = compareNumber(actual.videoBitrate, target.videoBitrate, bitrateOperator, tolerance);
      checks.videoBitrate = passed;
      if (!passed) {
        if (bitrateOperator === '>=') {
          const effectiveMin = Math.max(0, target.videoBitrate - tolerance);
          mismatches.push(`video bitrate ${formatBps(actual.videoBitrate)} is below minimum ${formatBps(effectiveMin)} (target ${formatBps(target.videoBitrate)}, ±${tolerancePercent}%)`);
        } else if (bitrateOperator === '<=') {
          const effectiveMax = target.videoBitrate + tolerance;
          mismatches.push(`video bitrate ${formatBps(actual.videoBitrate)} is above maximum ${formatBps(effectiveMax)} (target ${formatBps(target.videoBitrate)}, ±${tolerancePercent}%)`);
        } else {
          mismatches.push(`video bitrate expected≈${formatBps(target.videoBitrate)} (±${tolerancePercent}%) actual=${formatBps(actual.videoBitrate)}`);
        }
      }
    }
  }

  if (target.audioCodec && actual.audioCodec !== target.audioCodec) {
    checks.audioCodec = false;
    mismatches.push(`audio codec expected=${target.audioCodec} actual=${actual.audioCodec || 'unknown'}`);
  } else if (target.audioCodec) {
    checks.audioCodec = true;
  }

  if (Number.isFinite(target.audioChannels)) {
    const channelOperator = normalizeOperator(target.audioChannelsOp);
    if (!Number.isFinite(actual.audioChannels)) {
      checks.audioChannels = false;
      mismatches.push(`audio channels rule ${channelOperator} ${target.audioChannels} but actual channels are unknown`);
    } else {
      const passed = compareNumber(actual.audioChannels, target.audioChannels, channelOperator);
      checks.audioChannels = passed;
      if (!passed) {
        if (channelOperator === '>=') {
          mismatches.push(`audio channels ${actual.audioChannels} are below minimum ${target.audioChannels}`);
        } else if (channelOperator === '<=') {
          mismatches.push(`audio channels ${actual.audioChannels} are above maximum ${target.audioChannels}`);
        } else {
          mismatches.push(`audio channels expected=${target.audioChannels} actual=${actual.audioChannels}`);
        }
      }
    }
  }

  return {
    matches: mismatches.length === 0,
    mismatches,
    checks
  };
}

export async function inspectOne(file, target) {
  const probe = await runFfprobe(file.path);

  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  const audioStream = (probe.streams || []).find((stream) => stream.codec_type === 'audio');

  const actual = {
    videoCodec: videoStream?.codec_name?.toLowerCase(),
    videoBitrate: pickBitrate(videoStream, probe.format),
    audioCodec: audioStream?.codec_name?.toLowerCase(),
    audioChannels: Number.parseInt(audioStream?.channels, 10)
  };

  return {
    file,
    actual,
    ...evaluateMatch(target, actual)
  };
}

export async function inspectWithFallback(file, target) {
  try {
    return await inspectOne(file, target);
  } catch (error) {
    return {
      file,
      actual: {},
      matches: false,
      mismatches: [`ffprobe failed: ${error.message}`]
    };
  }
}

export async function runAudit({ root, criteria }) {
  const rootPath = path.resolve(root);
  const files = await collectVideoFiles(rootPath);

  const results = [];
  const BATCH_SIZE = 10;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((file) => inspectWithFallback(file, criteria))
    );
    results.push(...batchResults);
  }

  return {
    rootPath,
    files,
    results,
    mismatchedCount: results.filter((item) => !item.matches).length
  };
}
