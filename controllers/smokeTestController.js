import { getCodecOptions } from '../services/optionsService.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

const smokeStreamClients = new Set();
const smokeEventHistory = [];
const MAX_SMOKE_EVENT_HISTORY = 600;
let smokeInProgress = false;
let smokeCancelRequested = false;
let activeSmokeFfmpeg = null;

function writeSmokeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  const text = String(payload ?? '');
  for (const line of text.split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

function broadcastSmokeEvent(event, payload) {
  smokeEventHistory.push({ event, payload: String(payload ?? '') });
  if (smokeEventHistory.length > MAX_SMOKE_EVENT_HISTORY) {
    smokeEventHistory.splice(0, smokeEventHistory.length - MAX_SMOKE_EVENT_HISTORY);
  }
  for (const client of smokeStreamClients) {
    writeSmokeSseEvent(client, event, payload);
  }
}

function broadcastSmokeState() {
  const payload = JSON.stringify({ inProgress: smokeInProgress, cancelRequested: smokeCancelRequested });
  for (const client of smokeStreamClients) {
    writeSmokeSseEvent(client, 'state', payload);
  }
}

function runFfmpeg(args, hooks = {}) {
  const { onLog, onSpawn } = hooks;
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (typeof onSpawn === 'function') {
      onSpawn(child);
    }
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (typeof onLog === 'function') {
        onLog(text);
      }
    });
    child.stdout.on('data', (chunk) => {
      if (typeof onLog === 'function') {
        onLog(chunk.toString());
      }
    });
    child.on('error', (error) => reject(new Error(`Failed to start ffmpeg: ${error.message}`)));
    child.on('close', (code) => {
      if (smokeCancelRequested) {
        reject(new Error('Smoke generation cancelled.'));
        return;
      }
      if (code !== 0) reject(new Error(`ffmpeg exit code ${code}: ${stderr.trim() || 'unknown error'}`));
      else resolve();
    });
  });
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInRange(min, max) {
  if (min === max) {
    return min;
  }
  return min + (Math.random() * (max - min));
}

function normalizeDurationRange(minInput, maxInput) {
  const parsedMin = Number.parseFloat(minInput);
  const parsedMax = Number.parseFloat(maxInput);
  let min = Number.isFinite(parsedMin) ? parsedMin : 30;
  let max = Number.isFinite(parsedMax) ? parsedMax : 120;
  min = Math.max(1, min);
  max = Math.max(1, max);
  if (min > max) {
    [min, max] = [max, min];
  }
  return { min, max };
}

function normalizeBitrateRange(minInput, maxInput) {
  const parsedMin = Number.parseFloat(minInput);
  const parsedMax = Number.parseFloat(maxInput);
  let min = Number.isFinite(parsedMin) ? parsedMin : 2500;
  let max = Number.isFinite(parsedMax) ? parsedMax : 9000;
  min = Math.max(300, Math.min(100000, min));
  max = Math.max(300, Math.min(100000, max));
  if (min > max) {
    [min, max] = [max, min];
  }
  return { min, max };
}

function randomBitrateKbps(min, max) {
  const picked = randomInRange(min, max);
  return Math.max(300, Math.min(100000, Math.round(picked / 100) * 100));
}

function isGpuCodec(codec) {
  const value = String(codec || '').toLowerCase();
  return value.includes('videotoolbox')
    || value.includes('nvenc')
    || value.includes('qsv')
    || value.includes('vaapi')
    || value.includes('amf')
    || value.includes('cuda');
}

function resolveVideoExtension(codec) {
  const value = String(codec || '').toLowerCase();
  if (value.includes('vp9') || value.includes('vp8') || value.includes('libvpx')) {
    return 'webm';
  }
  if (value.includes('h264') || value.includes('x264')) {
    return 'mp4';
  }
  if (value.includes('hevc') || value.includes('h265') || value.includes('x265')) {
    return 'mkv';
  }
  return null;
}

function makeCommand({ outputPath, vCodec, vBitrate, aCodec, channels, duration, overwrite }) {
  const args = [];
  if (overwrite) args.push('-y');
  args.push(
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${duration}`,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-shortest',
    '-c:v', vCodec,
    '-b:v', vBitrate,
    '-pix_fmt', 'yuv420p',
    '-c:a', aCodec,
    '-ac', String(channels),
    '-ar', '48000',
    outputPath
  );
  return args;
}

export async function generateSmokeTestHandler(req, res) {
  if (smokeInProgress) {
    return res.status(409).json({ ok: false, error: 'Smoke generation already in progress.' });
  }

  const count = Math.max(1, Math.min(100, parseInt(req.body.count, 10) || 20));
  const mode = req.body.mode || 'random';
  const selectedVideoCodecs = Array.isArray(req.body.selectedVideoCodecs)
    ? req.body.selectedVideoCodecs.map((codec) => String(codec || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const durationRange = normalizeDurationRange(
    req.body.minDurationSec ?? req.body.minDurationMin,
    req.body.maxDurationSec ?? req.body.maxDurationMin
  );
  const bitrateRange = normalizeBitrateRange(req.body.minBitrateKbps, req.body.maxBitrateKbps);
  const useGpuCodecsOnly = req.body.useGpuCodecsOnly === true || req.body.useGpuCodecsOnly === 'true';
  // Define output directory for generated files
  const outDir = path.resolve('smoke-fixtures');
  const overwrite = true;
  smokeEventHistory.length = 0;
  smokeInProgress = true;
  smokeCancelRequested = false;
  broadcastSmokeState();
  broadcastSmokeEvent('status', `Smoke generation started. mode=${mode}, count=${count}, length=${durationRange.min}-${durationRange.max}sec, bitrate=${bitrateRange.min}-${bitrateRange.max}k, gpuOnly=${useGpuCodecsOnly ? 'yes' : 'no'}`);
  try {
    // Delete the output directory and all its contents if it exists
    await fs.rm(outDir, { recursive: true, force: true });

    // Dynamically detect available codecs
    const { videoCodecs, audioCodecs } = await getCodecOptions();
    // Only use popular, reliable video codecs if available
    // Include GPU variants so "GPU only" mode can function correctly.
    const allowedVideo = [
      'h264',
      'hevc',
      'vp9',
      'libx264',
      'libx265',
      'libvpx-vp9',
      'h264_videotoolbox',
      'hevc_videotoolbox',
      'h264_nvenc',
      'hevc_nvenc',
      'av1_nvenc',
      'h264_qsv',
      'hevc_qsv',
      'av1_qsv',
      'h264_vaapi',
      'hevc_vaapi',
      'av1_vaapi',
      'h264_amf',
      'hevc_amf',
      'av1_amf'
    ];
    // Only use non-experimental encoders for audio
    const allowedAudio = ['aac', 'ac3', 'libopus'];
    let safeVideo = videoCodecs
      .filter(c => allowedVideo.includes(c))
      .map((codec) => ({ codec, ext: resolveVideoExtension(codec) }))
      .filter((item) => Boolean(item.ext));

    if (selectedVideoCodecs.length > 0) {
      const requestedSet = new Set(selectedVideoCodecs);
      safeVideo = safeVideo.filter((item) => requestedSet.has(item.codec));
      broadcastSmokeEvent('status', `Requested video codecs: ${selectedVideoCodecs.join(', ')}`);
    }

    if (useGpuCodecsOnly) {
      const availableGpuCodecs = videoCodecs.filter((codec) => isGpuCodec(codec));
      broadcastSmokeEvent('status', `Detected GPU codecs: ${availableGpuCodecs.length ? availableGpuCodecs.join(', ') : '(none)'}`);
      safeVideo = safeVideo.filter((item) => isGpuCodec(item.codec));
    }

    if (!safeVideo.length) {
      const reason = selectedVideoCodecs.length > 0
        ? 'No available video codecs matched your advanced selections.'
        : (useGpuCodecsOnly
            ? 'No available GPU video codecs for smoke test generation.'
            : 'No available video codecs for smoke test generation.');
      return res.status(500).json({ ok: false, error: reason });
    }
    // Prefer libopus over opus, only use libopus if available
    let safeAudio = audioCodecs.filter(c => allowedAudio.includes(c));
    if (safeAudio.includes('libopus')) {
      safeAudio = safeAudio.filter(c => c !== 'opus');
    }
    const channelMap = {
      aac:    [1, 2, 4, 6, 8],
      ac3:    [1, 2, 3, 4, 5, 6],
      libopus:[1, 2]
    };
    let generated = 0;
    if (mode === 'combos' || mode === 'both') {
      for (const item of comboCases()) {
        if (smokeCancelRequested) {
          throw new Error('Smoke generation cancelled.');
        }
        // Validate combos for container/audio compatibility
        if (!safeVideo.find(v => v.codec === item.vCodec && v.ext === item.ext)) continue;
        if (!safeAudio.includes(item.aCodec)) continue;
        if (item.ext === 'webm' && item.aCodec !== 'libopus') continue;
        if (!channelMap[item.aCodec] || !channelMap[item.aCodec].includes(item.channels)) continue;
        const initialBitrate = `${randomBitrateKbps(bitrateRange.min, bitrateRange.max)}k`;
        const clipDurationSeconds = randomInRange(durationRange.min, durationRange.max);
        const clipDuration = Math.max(1, Math.round(clipDurationSeconds));
        const file = `combo_${String(generated+1).padStart(3,'0')}_${item.vCodec}_${initialBitrate}_${item.aCodec}_ch${item.channels}.${item.ext}`;
        const targetDir = path.join(outDir, `combo-${item.vCodec}-${item.aCodec}-ch${item.channels}`);
        const targetFile = path.join(targetDir, file);
        await fs.mkdir(targetDir, { recursive: true });
        broadcastSmokeEvent('status', `Generating ${file}`);
        const cmd = makeCommand({
          outputPath: targetFile,
          vCodec: item.vCodec,
          vBitrate: initialBitrate,
          aCodec: item.aCodec,
          channels: item.channels,
          duration: clipDuration,
          overwrite
        });
        await runFfmpeg(cmd, {
          onSpawn: (child) => {
            activeSmokeFfmpeg = child;
          },
          onLog: (text) => {
            broadcastSmokeEvent('log', text);
          }
        });
        activeSmokeFfmpeg = null;
        broadcastSmokeEvent('status', `Completed ${file} length=${clipDuration}s bitrate=${initialBitrate}`);
        generated++;
      }
    }
    if (mode === 'random' || mode === 'both') {
      for (let i = 0; i < count; ++i) {
        if (smokeCancelRequested) {
          throw new Error('Smoke generation cancelled.');
        }
        const v = randomPick(safeVideo);
        if (!v) { i--; continue; }
        let allowedAudio;
        if (v.ext === 'webm') {
          allowedAudio = safeAudio.filter(a => a === 'libopus');
        } else {
          allowedAudio = safeAudio;
        }
        if (!allowedAudio.length) { i--; continue; }
        const aCodec = randomPick(allowedAudio);
        if (!aCodec) { i--; continue; }
        const vBitrate = `${randomBitrateKbps(bitrateRange.min, bitrateRange.max)}k`;
        const clipDurationSeconds = randomInRange(durationRange.min, durationRange.max);
        const clipDuration = Math.max(1, Math.round(clipDurationSeconds));
        const allowedChannels = channelMap[aCodec] || [2];
        const channels = randomPick(allowedChannels);
        if (!channels) { i--; continue; }
        // Avoid unsupported combos
        if (v.ext === 'webm' && aCodec !== 'libopus') { i--; continue; }
        if (!allowedChannels.includes(channels)) { i--; continue; }
        const file = `fixture_${String(generated+1).padStart(3,'0')}_${v.codec}_${vBitrate}_${aCodec}_ch${channels}.${v.ext}`;
        const targetDir = path.join(outDir, `${v.codec}-${aCodec}-ch${channels}`);
        const targetFile = path.join(targetDir, file);
        await fs.mkdir(targetDir, { recursive: true });
        broadcastSmokeEvent('status', `Generating ${file}`);
        const cmd = makeCommand({
          outputPath: targetFile,
          vCodec: v.codec,
          vBitrate,
          aCodec,
          channels,
          duration: clipDuration,
          overwrite
        });
        await runFfmpeg(cmd, {
          onSpawn: (child) => {
            activeSmokeFfmpeg = child;
          },
          onLog: (text) => {
            broadcastSmokeEvent('log', text);
          }
        });
        activeSmokeFfmpeg = null;
        broadcastSmokeEvent('status', `Completed ${file} length=${clipDuration}s bitrate=${vBitrate}`);
        generated++;
      }
    }
    broadcastSmokeEvent('done', `Smoke generation finished. Generated ${generated} file(s).`);
    res.json({ ok: true, generated, outDir, durationRange, bitrateRange, useGpuCodecsOnly });
  } catch (error) {
    if (smokeCancelRequested) {
      broadcastSmokeEvent('done', 'Smoke generation cancelled.');
      res.status(499).json({ ok: false, error: 'Smoke generation cancelled.' });
    } else {
      broadcastSmokeEvent('done', `Smoke generation failed: ${error.message}`);
      res.status(500).json({ ok: false, error: error.message });
    }
  } finally {
    smokeInProgress = false;
    smokeCancelRequested = false;
    activeSmokeFfmpeg = null;
    broadcastSmokeState();
  }
}

export function smokeStreamHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  smokeStreamClients.add(res);
  writeSmokeSseEvent(res, 'state', JSON.stringify({ inProgress: smokeInProgress, cancelRequested: smokeCancelRequested }));
  writeSmokeSseEvent(res, 'status', smokeInProgress ? 'Smoke generation in progress.' : 'Connected. Waiting for smoke generation.');
  for (const entry of smokeEventHistory) {
    writeSmokeSseEvent(res, entry.event, entry.payload);
  }

  req.on('close', () => {
    smokeStreamClients.delete(res);
  });
}

export function smokeCancelHandler(req, res) {
  if (!smokeInProgress) {
    return res.status(400).json({ ok: false, error: 'No smoke generation in progress.' });
  }

  smokeCancelRequested = true;
  broadcastSmokeState();
  if (activeSmokeFfmpeg && activeSmokeFfmpeg.kill) {
    try {
      activeSmokeFfmpeg.kill('SIGTERM');
    } catch {
    }
  }
  broadcastSmokeEvent('status', 'Cancellation requested...');
  return res.json({ ok: true, message: 'Smoke generation cancellation requested.' });
}
