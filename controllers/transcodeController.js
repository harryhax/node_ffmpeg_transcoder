import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

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

function buildLogPathFromOutput(outputPath) {
  const ext = path.extname(outputPath);
  const base = path.basename(outputPath, ext);
  const dir = path.dirname(outputPath);
  return path.join(dir, `${base}.log`);
}

const transcodeStreamClients = new Set();
let transcodeInProgress = false;
let lastFfmpegProcessPaused = false;

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

async function readBatteryInfo() {
  if (process.platform !== 'darwin') {
    return { available: false };
  }

  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt']);
    const percentMatch = stdout.match(/(\d+)%/);
    const chargingMatch = stdout.match(/;\s*(charging|discharging|charged);/i);

    return {
      available: true,
      percent: percentMatch ? Number.parseInt(percentMatch[1], 10) : null,
      state: chargingMatch ? chargingMatch[1].toLowerCase() : 'unknown'
    };
  } catch {
    return { available: false };
  }
}

function normalizePauseBatteryPct(input) {
  if (input === undefined || input === null || input === '') {
    return null;
  }

  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value) || value < 1 || value > 99) {
    throw new Error('Pause battery percent must be between 1 and 99.');
  }
  return value;
}

function normalizeStartBatteryPct(input) {
  if (input === undefined || input === null || input === '') {
    return null;
  }

  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value) || value < 1 || value > 99) {
    throw new Error('Start battery percent must be between 1 and 99.');
  }
  return value;
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'unknown';
  }
  return `${bytes} bytes`;
}

function formatDate(value) {
  if (!value) {
    return 'unknown';
  }
  return new Date(value).toISOString();
}

function formatCommand(command, args) {
  return `${command} ${args.map((arg) => (String(arg).includes(' ') ? JSON.stringify(String(arg)) : String(arg))).join(' ')}`;
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
      resolve({ code, stdout, stderr });
    });
  });
}

async function collectFileDetails(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  const ffprobeArgs = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath];
  const ffprobeResult = await runCommand('ffprobe', ffprobeArgs).catch((error) => ({ code: -1, stdout: '', stderr: error.message }));

  return {
    filePath,
    stat,
    ffprobe: {
      command: formatCommand('ffprobe', ffprobeArgs),
      ...ffprobeResult
    }
  };
}

async function writePerFileTranscodeLog({
  logPath,
  sourcePath,
  outputPath,
  ffmpegCommand,
  ffmpegStdout,
  ffmpegStderr,
  status,
  errorMessage
}) {
  const sourceDetails = await collectFileDetails(sourcePath);
  const outputDetails = outputPath ? await collectFileDetails(outputPath) : null;

  const lines = [
    `status: ${status}`,
    `source: ${sourcePath}`,
    `output: ${outputPath || 'n/a'}`,
    `ffmpeg command: ${ffmpegCommand}`,
    '',
    '[source file stat]',
    `size: ${sourceDetails?.stat ? formatBytes(sourceDetails.stat.size) : 'missing'}`,
    `mtime: ${sourceDetails?.stat ? formatDate(sourceDetails.stat.mtime) : 'missing'}`,
    '',
    '[source ffprobe command]',
    sourceDetails.ffprobe.command,
    '[source ffprobe stdout]',
    sourceDetails.ffprobe.stdout || '(empty)',
    '[source ffprobe stderr]',
    sourceDetails.ffprobe.stderr || '(empty)',
    '',
    '[ffmpeg stdout]',
    ffmpegStdout || '(empty)',
    '[ffmpeg stderr]',
    ffmpegStderr || '(empty)'
  ];

  if (outputDetails) {
    lines.push(
      '',
      '[output file stat]',
      `size: ${outputDetails?.stat ? formatBytes(outputDetails.stat.size) : 'missing'}`,
      `mtime: ${outputDetails?.stat ? formatDate(outputDetails.stat.mtime) : 'missing'}`,
      '',
      '[output ffprobe command]',
      outputDetails.ffprobe.command,
      '[output ffprobe stdout]',
      outputDetails.ffprobe.stdout || '(empty)',
      '[output ffprobe stderr]',
      outputDetails.ffprobe.stderr || '(empty)'
    );
  }

  if (errorMessage) {
    lines.push('', '[error]', errorMessage);
  }

  await fs.writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
}

// Store last ffmpeg process for streaming
let lastFfmpegProcess = null;

const transcode = async (req, res) => {
  const { files, videoCodec, audioCodec, videoBitrate, audioChannels, deleteOriginal, transcodeLocation, pauseBatteryPct, startBatteryPct, saveTranscodeLog } = req.body;
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ ok: false, error: 'No files provided.' });
  }

  let pauseBatteryThreshold = null;
  let startBatteryThreshold = null;
  try {
    pauseBatteryThreshold = normalizePauseBatteryPct(pauseBatteryPct);
    startBatteryThreshold = normalizeStartBatteryPct(startBatteryPct);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  if (
    Number.isFinite(startBatteryThreshold) &&
    Number.isFinite(pauseBatteryThreshold) &&
    startBatteryThreshold <= pauseBatteryThreshold
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Start battery percent must be greater than pause battery percent.'
    });
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
    let ffmpegStdout = '';
    let ffmpegStderr = '';
    let ffmpegCommand = '';
    let finalOutputPath = null;
    let perFileLogPath = null;
    try {
      if (Number.isFinite(startBatteryThreshold)) {
        const battery = await readBatteryInfo();
        if (!battery.available || !Number.isFinite(battery.percent)) {
          const errorText = `Cannot verify battery for start threshold ${startBatteryThreshold}%.`;
          results.push({ file, output: null, ok: false, error: errorText, logPath: null });
          broadcastTranscodeEvent('status', `Skipped: ${path.basename(file)} (${errorText})`);
          continue;
        }
        if (battery.percent <= startBatteryThreshold) {
          const errorText = `Battery ${battery.percent}% is not above start threshold ${startBatteryThreshold}%.`;
          results.push({ file, output: null, ok: false, error: errorText, logPath: null });
          broadcastTranscodeEvent('status', `Skipped: ${path.basename(file)} (${errorText})`);
          continue;
        }
      }

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
      ffmpegCommand = commandText;
      broadcastTranscodeEvent('status', `Processing: ${file}`);
      broadcastTranscodeEvent('log', commandText);
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args);
        lastFfmpegProcess = ff;
        lastFfmpegProcessPaused = false;
        let batteryCheckInFlight = false;
        const batteryMonitorInterval = pauseBatteryThreshold
          ? setInterval(async () => {
            if (batteryCheckInFlight || !lastFfmpegProcess || lastFfmpegProcess !== ff) {
              return;
            }

            batteryCheckInFlight = true;
            try {
              const battery = await readBatteryInfo();
              if (!battery.available || !Number.isFinite(battery.percent)) {
                return;
              }

              if (!lastFfmpegProcessPaused && battery.percent <= pauseBatteryThreshold) {
                ff.kill('SIGSTOP');
                lastFfmpegProcessPaused = true;
                broadcastTranscodeEvent('status', `Paused: battery at ${battery.percent}% (threshold ${pauseBatteryThreshold}%).`);
              } else if (lastFfmpegProcessPaused && battery.percent >= Math.min(100, pauseBatteryThreshold + 2)) {
                ff.kill('SIGCONT');
                lastFfmpegProcessPaused = false;
                broadcastTranscodeEvent('status', `Resumed: battery recovered to ${battery.percent}%.`);
              }
            } catch {
            } finally {
              batteryCheckInFlight = false;
            }
          }, 15000)
          : null;
        let stderr = '';
        ff.stderr.on('data', d => {
          const msg = d.toString();
          stderr += msg;
          ffmpegStderr += msg;
          broadcastTranscodeEvent('log', msg);
        });
        ff.stdout && ff.stdout.on('data', d => {
          const msg = d.toString();
          ffmpegStdout += msg;
          broadcastTranscodeEvent('log', msg);
        });
        ff.on('close', code => {
          if (batteryMonitorInterval) {
            clearInterval(batteryMonitorInterval);
          }
          lastFfmpegProcess = null;
          lastFfmpegProcessPaused = false;
          if (code === 0) resolve();
          else reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        });
      });
      // If transcodeLocation, copy result back to original folder
      if (safeTranscodeLocation && tempOutput) {
        const origOutput = buildOutputPath(file, { videoCodec, audioCodec });
        await fs.copyFile(tempOutput, origOutput);
        finalOutputPath = origOutput;
        await verifyTranscodeOutput(verificationInput, origOutput);
        // Clean up temp files
        await fs.unlink(tempInput);
        await fs.unlink(tempOutput);
        if (deleteOriginal) {
          try {
            console.log(`Deleting original file: ${file}`);
            await fs.unlink(file);
          } catch (delErr) {
            results.push({ file, output: origOutput, ok: true, warning: `Transcoded, but failed to delete original: ${delErr.message}`, logPath: perFileLogPath });
            continue;
          }
        }
        results.push({ file, output: origOutput, ok: true, logPath: perFileLogPath });
      } else {
        finalOutputPath = verificationOutput;
        await verifyTranscodeOutput(verificationInput, verificationOutput);
        // No transcodeLocation, just handle output in place
        if (deleteOriginal) {
          try {
            console.log(`Deleting original file: ${file}`);
            await fs.unlink(file);
          } catch (delErr) {
            results.push({ file, output: workingOutput, ok: true, warning: `Transcoded, but failed to delete original: ${delErr.message}`, logPath: perFileLogPath });
            continue;
          }
        }
        results.push({ file, output: workingOutput, ok: true, logPath: perFileLogPath });
      }

      if (saveTranscodeLog === true || saveTranscodeLog === 'true') {
        const targetLogPath = buildLogPathFromOutput(finalOutputPath || buildOutputPath(file, { videoCodec, audioCodec }));
        perFileLogPath = targetLogPath;
        await writePerFileTranscodeLog({
          logPath: targetLogPath,
          sourcePath: file,
          outputPath: finalOutputPath,
          ffmpegCommand,
          ffmpegStdout,
          ffmpegStderr,
          status: 'success'
        });
        for (let i = results.length - 1; i >= 0; i -= 1) {
          if (results[i].file === file && !results[i].logPath) {
            results[i].logPath = perFileLogPath;
            break;
          }
        }
      }
    } catch (err) {
      results.push({ file, output: workingOutput, ok: false, error: err.message, logPath: perFileLogPath });
      broadcastTranscodeEvent('log', `ERROR ${file}: ${err.message}`);

      if (saveTranscodeLog === true || saveTranscodeLog === 'true') {
        const fallbackOutput = finalOutputPath || workingOutput || buildOutputPath(file, { videoCodec, audioCodec });
        const targetLogPath = buildLogPathFromOutput(fallbackOutput);
        perFileLogPath = targetLogPath;
        try {
          await writePerFileTranscodeLog({
            logPath: targetLogPath,
            sourcePath: file,
            outputPath: finalOutputPath,
            ffmpegCommand,
            ffmpegStdout,
            ffmpegStderr,
            status: 'failed',
            errorMessage: err.message
          });
          for (let i = results.length - 1; i >= 0; i -= 1) {
            if (results[i].file === file && !results[i].logPath) {
              results[i].logPath = perFileLogPath;
              break;
            }
          }
        } catch {
        }
      }

      // Clean up temp files if error
      if (tempInput) { try { await fs.unlink(tempInput); } catch {} }
      if (tempOutput) { try { await fs.unlink(tempOutput); } catch {} }
    }
  }

  transcodeInProgress = false;
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    broadcastTranscodeEvent('done', 'Transcode finished with errors.');
    return res.status(500).json({ ok: false, error: `Some files failed: ${failed.map(f => f.file).join(', ')}`, results });
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
    if (lastFfmpegProcessPaused) {
      try {
        lastFfmpegProcess.kill('SIGCONT');
      } catch {
      }
    }
    lastFfmpegProcess.kill('SIGTERM');
    lastFfmpegProcessPaused = false;
    console.log('Transcode cancelled by user.');
    return res.json({ ok: true, message: 'Transcode cancelled.' });
  }
  res.status(400).json({ ok: false, error: 'No transcode in progress.' });
};

export default { transcode, transcodeStream, transcodeCancel };
