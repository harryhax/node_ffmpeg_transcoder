import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs/promises';

const transcodeLocationRoot = path.resolve(process.env.TRANSCODE_LOCATION_ROOT || process.cwd());

function resolveTranscodeLocation(inputPath) {
  if (!inputPath) {
    return null;
  }

  const resolved = path.resolve(String(inputPath));
  const relativeToRoot = path.relative(transcodeLocationRoot, resolved);
  const isInsideRoot =
    relativeToRoot === '' ||
    (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot));

  if (!isInsideRoot) {
    throw new Error(`transcodeLocation must be inside ${transcodeLocationRoot}`);
  }

  return resolved;
}

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

function buildOutputPath(inputPath, opts = {}) {
  const inputExt = path.extname(inputPath).toLowerCase();
  const ext = inputExt === '.webm' && !isWebmCompatible(opts.videoCodec, opts.audioCodec)
    ? '.mkv'
    : inputExt;
  const base = path.basename(inputPath, inputExt);
  const dir = path.dirname(inputPath);
  return path.join(dir, `${base}.transcoded${ext}`);
}

function buildFfmpegArgs(input, output, opts) {
  const args = ['-y', '-i', input];
  if (opts.videoCodec) args.push('-c:v', opts.videoCodec);
  if (opts.videoBitrate) args.push('-b:v', `${opts.videoBitrate}k`);
  if (opts.audioCodec) args.push('-c:a', opts.audioCodec);
  if (opts.audioChannels) args.push('-ac', opts.audioChannels);
  args.push(output);
  return args;
}

const transcodeStreamClients = new Set();
let transcodeInProgress = false;

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  const text = String(payload ?? '');
  for (const line of text.split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

function broadcastTranscodeEvent(event, payload) {
  for (const client of transcodeStreamClients) {
    writeSseEvent(client, event, payload);
  }
}

function runFfprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ];

    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to start ffprobe: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exit code ${code}: ${stderr.trim() || 'unknown error'}`));
        return;
      }

      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error('Could not read media duration from ffprobe.'));
        return;
      }

      resolve(duration);
    });
  });
}

async function verifyTranscodeOutput(inputPath, outputPath) {
  const outputStat = await fs.stat(outputPath);
  if (!outputStat.isFile() || outputStat.size <= 0) {
    throw new Error('Output file missing or empty after transcode.');
  }

  const [inputDuration, outputDuration] = await Promise.all([
    runFfprobeDuration(inputPath),
    runFfprobeDuration(outputPath)
  ]);

  const durationDiff = Math.abs(inputDuration - outputDuration);
  const toleranceSeconds = Math.max(2, inputDuration * 0.05);
  if (durationDiff > toleranceSeconds) {
    throw new Error(
      `Output duration differs too much from input (input=${inputDuration.toFixed(2)}s output=${outputDuration.toFixed(2)}s).`
    );
  }
}

// Store last ffmpeg process for streaming
let lastFfmpegProcess = null;

const transcode = async (req, res) => {
  const { files, videoCodec, audioCodec, videoBitrate, audioChannels, deleteOriginal, transcodeLocation } = req.body;
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ ok: false, error: 'No files provided.' });
  }
  let safeTranscodeLocation = null;
  try {
    safeTranscodeLocation = resolveTranscodeLocation(transcodeLocation);
    if (safeTranscodeLocation) {
      await fs.mkdir(safeTranscodeLocation, { recursive: true });
    }
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  transcodeInProgress = true;
  broadcastTranscodeEvent('status', `Transcode started for ${files.length} file(s).`);

  const results = [];

  for (const file of files) {
    let workingInput = file;
    let workingOutput;
    let verificationInput = file;
    let verificationOutput;
    let tempInput = null;
    let tempOutput = null;
    try {
      // If transcodeLocation is set, copy file there and transcode in that folder
      if (safeTranscodeLocation) {
        const fileName = path.basename(file);
        tempInput = path.join(safeTranscodeLocation, fileName);
        await fs.copyFile(file, tempInput);
        workingInput = tempInput;
        tempOutput = buildOutputPath(tempInput, { videoCodec, audioCodec });
        workingOutput = tempOutput;
        verificationOutput = buildOutputPath(file, { videoCodec, audioCodec });
      } else {
        workingOutput = buildOutputPath(file, { videoCodec, audioCodec });
        verificationOutput = workingOutput;
      }
      const args = buildFfmpegArgs(workingInput, workingOutput, { videoCodec, audioCodec, videoBitrate, audioChannels });
      const commandText = `ffmpeg ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
      broadcastTranscodeEvent('status', `Processing: ${file}`);
      broadcastTranscodeEvent('log', commandText);
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args);
        lastFfmpegProcess = ff;
        let stderr = '';
        ff.stderr.on('data', d => {
          const msg = d.toString();
          stderr += msg;
          broadcastTranscodeEvent('log', msg);
        });
        ff.stdout && ff.stdout.on('data', d => broadcastTranscodeEvent('log', d.toString()));
        ff.on('close', code => {
          lastFfmpegProcess = null;
          if (code === 0) resolve();
          else reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        });
      });
      // If transcodeLocation, copy result back to original folder
      if (safeTranscodeLocation && tempOutput) {
        const origOutput = buildOutputPath(file, { videoCodec, audioCodec });
        await fs.copyFile(tempOutput, origOutput);
        await verifyTranscodeOutput(verificationInput, origOutput);
        // Clean up temp files
        await fs.unlink(tempInput);
        await fs.unlink(tempOutput);
        if (deleteOriginal) {
          try {
            console.log(`Deleting original file: ${file}`);
            await fs.unlink(file);
          } catch (delErr) {
            results.push({ file, output: origOutput, ok: true, warning: `Transcoded, but failed to delete original: ${delErr.message}` });
            continue;
          }
        }
        results.push({ file, output: origOutput, ok: true });
      } else {
        await verifyTranscodeOutput(verificationInput, verificationOutput);
        // No transcodeLocation, just handle output in place
        if (deleteOriginal) {
          try {
            console.log(`Deleting original file: ${file}`);
            await fs.unlink(file);
          } catch (delErr) {
            results.push({ file, output: workingOutput, ok: true, warning: `Transcoded, but failed to delete original: ${delErr.message}` });
            continue;
          }
        }
        results.push({ file, output: workingOutput, ok: true });
      }
    } catch (err) {
      results.push({ file, output: workingOutput, ok: false, error: err.message });
      broadcastTranscodeEvent('log', `ERROR ${file}: ${err.message}`);
      // Clean up temp files if error
      if (tempInput) { try { await fs.unlink(tempInput); } catch {} }
      if (tempOutput) { try { await fs.unlink(tempOutput); } catch {} }
    }
  }

  transcodeInProgress = false;
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    broadcastTranscodeEvent('done', 'Transcode finished with errors.');
    return res.status(500).json({ ok: false, error: `Some files failed: ${failed.map(f => f.file).join(', ')}` });
  }
  broadcastTranscodeEvent('done', 'Transcode finished successfully.');
  res.json({ ok: true, message: `Transcoded ${results.length} file(s).`, results });
};

// SSE endpoint for streaming ffmpeg output
const transcodeStream = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  transcodeStreamClients.add(res);
  writeSseEvent(res, 'status', transcodeInProgress ? 'Transcode in progress.' : 'Connected. Waiting for transcode.');
  req.on('close', () => {
    transcodeStreamClients.delete(res);
  });
};

// Cancel endpoint: kill ffmpeg process
export const transcodeCancel = (req, res) => {
  if (lastFfmpegProcess && lastFfmpegProcess.kill) {
    lastFfmpegProcess.kill('SIGTERM');
    console.log('Transcode cancelled by user.');
    return res.json({ ok: true, message: 'Transcode cancelled.' });
  }
  res.status(400).json({ ok: false, error: 'No transcode in progress.' });
};

export default { transcode, transcodeStream, transcodeCancel };
