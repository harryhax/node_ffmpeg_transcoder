#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const args = {
    out: './smoke-fixtures',
    overwrite: true,
    duration: 4
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--out' && next) {
      args.out = next;
      i += 1;
    } else if (token === '--duration' && next) {
      args.duration = Number.parseFloat(next);
      i += 1;
    } else if (token === '--no-overwrite') {
      args.overwrite = false;
    } else if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.duration) || args.duration <= 0) {
    throw new Error('--duration must be a positive number.');
  }

  return args;
}

function printHelp() {
  console.log(`Smoke Test Fixture Generator\n\nUsage:\n  node src/smoke-test.js [options]\n\nOptions:\n  --out <path>        Output folder (default: ./smoke-fixtures)\n  --duration <secs>   Clip duration in seconds (default: 4)\n  --no-overwrite      Do not pass -y to ffmpeg\n  -h, --help          Show help\n`);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit code ${code}: ${stderr.trim() || 'unknown error'}`));
        return;
      }
      resolve();
    });
  });
}

function makeCommand({ outputPath, vCodec, vBitrate, aCodec, channels, duration, overwrite }) {
  const args = [];

  if (overwrite) {
    args.push('-y');
  }

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

function isSupportedCombination(audioCodec, channels) {
  if ((audioCodec === 'ac3' || audioCodec === 'eac3') && channels === 8) {
    return false;
  }

  if (audioCodec === 'libopus' && ![1, 2].includes(channels)) {
    return false;
  }

  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  const outRoot = path.resolve(args.out);

  const cases = [];
  const videoVariants = [
    { label: 'x265', codec: 'libx265', ext: 'mkv' },
    { label: 'x264', codec: 'libx264', ext: 'mp4' },
    { label: 'mpeg4', codec: 'mpeg4', ext: 'mkv' },
    { label: 'vp9', codec: 'libvpx-vp9', ext: 'webm' }
  ];
  const bitrateVariants = ['2500k', '4500k', '6000k', '7500k', '9000k'];
  const audioVariants = [
    { label: 'ac3', codec: 'ac3' },
    { label: 'aac', codec: 'aac' },
    { label: 'eac3', codec: 'eac3' },
    { label: 'opus', codec: 'libopus' }
  ];
  const channelVariants = [1, 2, 4, 6, 8];

  let fileIndex = 1;
  for (const video of videoVariants) {
    for (const bitrate of bitrateVariants) {
      for (const audio of audioVariants) {
        for (const channels of channelVariants) {
          if (cases.length >= 50) {
            break;
          }

          if (!isSupportedCombination(audio.codec, channels)) {
            continue;
          }

          const group = `group-${String(Math.floor(cases.length / 10) + 1).padStart(2, '0')}`;
          const dir = `${group}/${video.label}-${audio.label}-ch${channels}`;
          const file = `fixture_${String(fileIndex).padStart(3, '0')}_${video.label}_${bitrate}_${audio.label}_ch${channels}.${video.ext}`;

          cases.push({
            dir,
            file,
            vCodec: video.codec,
            vBitrate: bitrate,
            aCodec: audio.codec,
            channels
          });

          fileIndex += 1;
        }
        if (cases.length >= 50) {
          break;
        }
      }
      if (cases.length >= 50) {
        break;
      }
    }
    if (cases.length >= 50) {
      break;
    }
  }

  console.log(`Generating ${cases.length} smoke-test media file(s) in: ${outRoot}`);

  for (const item of cases) {
    const targetDir = path.join(outRoot, item.dir);
    const targetFile = path.join(targetDir, item.file);

    await fs.mkdir(targetDir, { recursive: true });

    const cmd = makeCommand({
      outputPath: targetFile,
      vCodec: item.vCodec,
      vBitrate: item.vBitrate,
      aCodec: item.aCodec,
      channels: item.channels,
      duration: args.duration,
      overwrite: args.overwrite
    });

    process.stdout.write(`- ${path.relative(outRoot, targetFile)} ... `);
    await runFfmpeg(cmd);
    process.stdout.write('ok\n');
  }

  console.log('Smoke-test fixture generation complete.');
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
});
