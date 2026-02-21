import { getCodecOptions } from '../services/optionsService.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(new Error(`Failed to start ffmpeg: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg exit code ${code}: ${stderr.trim() || 'unknown error'}`));
      else resolve();
    });
  });
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
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
  const count = Math.max(1, Math.min(100, parseInt(req.body.count, 10) || 20));
  const mode = req.body.mode || 'random';
  const duration = 4;
  // Define output directory for generated files
  const outDir = path.resolve('smoke-fixtures');
  const overwrite = true;
  try {
    // Delete the output directory and all its contents if it exists
    await fs.rm(outDir, { recursive: true, force: true });

    // Dynamically detect available codecs
    const { videoCodecs, audioCodecs } = await getCodecOptions();
    // Only use popular, reliable video codecs if available
    // Only use codecs that are exposed in the dropdowns (filtered popular codecs)
    const allowedVideo = ['h264', 'hevc', 'vp9', 'libx264', 'libx265', 'libvpx-vp9'];
    // Only use non-experimental encoders for audio
    const allowedAudio = ['aac', 'ac3', 'libopus'];
    // Map to preferred container for each video codec
    const videoExtMap = {
      'libx264': 'mp4', 'h264': 'mp4',
      'libx265': 'mkv', 'hevc': 'mkv',
      'libvpx-vp9': 'webm', 'vp9': 'webm'
    };
    const safeVideo = videoCodecs
      .filter(c => allowedVideo.includes(c))
      .map(codec => ({ codec, ext: videoExtMap[codec] }));
    // Prefer libopus over opus, only use libopus if available
    let safeAudio = audioCodecs.filter(c => allowedAudio.includes(c));
    if (safeAudio.includes('libopus')) {
      safeAudio = safeAudio.filter(c => c !== 'opus');
    }
    const vBitrates = ['2500k', '4500k', '6000k', '7500k', '9000k'];
    const channelMap = {
      aac:    [1, 2, 4, 6, 8],
      ac3:    [1, 2, 3, 4, 5, 6],
      libopus:[1, 2]
    };
    let generated = 0;
    if (mode === 'combos' || mode === 'both') {
      for (const item of comboCases()) {
        // Validate combos for container/audio compatibility
        if (!safeVideo.find(v => v.codec === item.vCodec && v.ext === item.ext)) continue;
        if (!safeAudio.includes(item.aCodec)) continue;
        if (item.ext === 'webm' && item.aCodec !== 'libopus') continue;
        if (!channelMap[item.aCodec] || !channelMap[item.aCodec].includes(item.channels)) continue;
        const file = `combo_${String(generated+1).padStart(3,'0')}_${item.vCodec}_${item.vBitrate}_${item.aCodec}_ch${item.channels}.${item.ext}`;
        const targetDir = path.join(outDir, `combo-${item.vCodec}-${item.aCodec}-ch${item.channels}`);
        const targetFile = path.join(targetDir, file);
        await fs.mkdir(targetDir, { recursive: true });
        const cmd = makeCommand({ outputPath: targetFile, vCodec: item.vCodec, vBitrate: item.vBitrate, aCodec: item.aCodec, channels: item.channels, duration, overwrite });
        await runFfmpeg(cmd);
        generated++;
      }
    }
    if (mode === 'random' || mode === 'both') {
      if (!safeVideo.length) {
        return res.status(500).json({ ok: false, error: 'No available video codecs for smoke test generation.' });
      }
      for (let i = 0; i < count; ++i) {
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
        const vBitrate = randomPick(vBitrates);
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
        const cmd = makeCommand({ outputPath: targetFile, vCodec: v.codec, vBitrate, aCodec, channels, duration, overwrite });
        await runFfmpeg(cmd);
        generated++;
      }
    }
    res.json({ ok: true, generated, outDir });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
