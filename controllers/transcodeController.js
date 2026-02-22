import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

const transcodeLocationRoot = path.resolve(process.env.TRANSCODE_LOCATION_ROOT || process.cwd());
const transcodeRunLogDir = path.resolve(process.cwd(), 'transcode-logs');

function makeRunLogPath(startedAtMs = Date.now()) {
  const stamp = new Date(startedAtMs).toISOString().replace(/[:.]/g, '-');
  return path.join(transcodeRunLogDir, `transcode-run-${stamp}.log`);
}

function stringifyForLog(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function writeTranscodeRunLog({
  logPath,
  startedAtMs,
  requestPayload,
  queuedDurations,
  fileDiagnostics,
  fileAttempts,
  results,
  savingsSummary
}) {
  const finishedAtMs = Date.now();
  const lines = [
    '[transcode run]',
    `startedAt: ${new Date(startedAtMs).toISOString()}`,
    `finishedAt: ${new Date(finishedAtMs).toISOString()}`,
    `durationSeconds: ${((finishedAtMs - startedAtMs) / 1000).toFixed(2)}`,
    `workingDir: ${process.cwd()}`,
    '',
    '[request payload]',
    stringifyForLog(requestPayload),
    '',
    '[queued durations seconds]',
    stringifyForLog(queuedDurations),
    '',
    '[input file diagnostics]',
    stringifyForLog(fileDiagnostics),
    '',
    '[file attempts]',
    stringifyForLog(fileAttempts),
    '',
    '[results]',
    stringifyForLog(results),
    '',
    '[savings summary]',
    stringifyForLog(savingsSummary)
  ];

  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
}

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

function buildFailLogPathFromOutput(outputPath) {
  const ext = path.extname(outputPath);
  const base = path.basename(outputPath, ext);
  const dir = path.dirname(outputPath);
  return path.join(dir, `${base}.fail.log`);
}

const transcodeStreamClients = new Set();
let transcodeInProgress = false;
let lastFfmpegProcessPaused = false;
let latestTranscodeStatusText = null;
let latestQueuePayloadText = null;
let latestOverallPayloadText = null;
let latestProgressPayloadText = null;
let latestFileStartPayload = null;
const transcodeSavingsTotals = {
  filesTranscoded: 0,
  attemptedFiles: 0,
  failedFiles: 0,
  sourceBytes: 0,
  outputBytes: 0,
  savedBytes: 0,
  reductionPctSum: 0,
  reductionPctCount: 0,
  startedAt: new Date().toISOString()
};

function getTranscodeSavingsSummary() {
  const attemptedFiles = transcodeSavingsTotals.attemptedFiles;
  const filesTranscoded = transcodeSavingsTotals.filesTranscoded;
  const failedFiles = transcodeSavingsTotals.failedFiles;
  const successRatePct = attemptedFiles > 0
    ? (filesTranscoded / attemptedFiles) * 100
    : 0;
  const avgReductionPct = transcodeSavingsTotals.reductionPctCount > 0
    ? (transcodeSavingsTotals.reductionPctSum / transcodeSavingsTotals.reductionPctCount)
    : 0;

  return {
    filesTranscoded,
    attemptedFiles,
    failedFiles,
    sourceBytes: transcodeSavingsTotals.sourceBytes,
    outputBytes: transcodeSavingsTotals.outputBytes,
    savedBytes: transcodeSavingsTotals.savedBytes,
    successRatePct,
    avgReductionPct,
    startedAt: transcodeSavingsTotals.startedAt
  };
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  const text = String(payload ?? '');
  for (const line of text.split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

function parseJsonSafe(payloadText) {
  if (typeof payloadText !== 'string' || !payloadText.trim()) {
    return null;
  }
  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

function getTranscodeLiveState() {
  return {
    inProgress: transcodeInProgress,
    status: latestTranscodeStatusText,
    queue: parseJsonSafe(latestQueuePayloadText),
    overall: parseJsonSafe(latestOverallPayloadText),
    progress: parseJsonSafe(latestProgressPayloadText),
    activeFile: latestFileStartPayload
  };
}

function resetTranscodeLiveSnapshots() {
  latestTranscodeStatusText = null;
  latestQueuePayloadText = null;
  latestOverallPayloadText = null;
  latestProgressPayloadText = null;
  latestFileStartPayload = null;
}

function broadcastTranscodeEvent(event, payload) {
  if (event === 'status') {
    latestTranscodeStatusText = String(payload ?? '');
  } else if (event === 'queue') {
    latestQueuePayloadText = String(payload ?? '');
  } else if (event === 'overall') {
    latestOverallPayloadText = String(payload ?? '');
  } else if (event === 'progress') {
    latestProgressPayloadText = String(payload ?? '');
  }

  for (const client of transcodeStreamClients) {
    writeSseEvent(client, event, payload);
  }
}

function emitTranscodeFileEvent(event, payload) {
  if (event === 'file-start') {
    latestFileStartPayload = payload;
  } else if ((event === 'file-complete' || event === 'file-failed') && latestFileStartPayload?.file === payload?.file) {
    latestFileStartPayload = null;
  }
  broadcastTranscodeEvent(event, JSON.stringify(payload));
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

function extractProgressFromChunk(chunkText) {
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

function runFfprobeDuration(filePath) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath];

    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function verifyTranscodeOutput(inputPath, outputPath) {
  const outputStat = await fs.stat(outputPath);
  if (!outputStat.isFile() || outputStat.size <= 0) {
    throw new Error('Output file missing or empty after transcode.');
  }

  const [inputDuration, outputDuration] = await Promise.all([
    runFfprobeDuration(inputPath),
    runFfprobeDuration(outputPath)
  ]);

  if (!Number.isFinite(inputDuration) || !Number.isFinite(outputDuration)) {
    return;
  }

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

async function readFileSizeSafe(filePath) {
  if (!filePath) {
    return null;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || !Number.isFinite(stat.size)) {
      return null;
    }
    return stat.size;
  } catch {
    return null;
  }
}

async function attachSizeStats(results) {
  return Promise.all(results.map(async (item) => {
    const sourceSizeBytes = await readFileSizeSafe(item.file);
    const outputSizeBytes = await readFileSizeSafe(item.output);
    const bytesSaved = Number.isFinite(sourceSizeBytes) && Number.isFinite(outputSizeBytes)
      ? (sourceSizeBytes - outputSizeBytes)
      : null;

    return {
      ...item,
      sourceSizeBytes,
      outputSizeBytes,
      bytesSaved
    };
  }));
}

function accumulateTranscodeSavings(results) {
  if (!Array.isArray(results) || !results.length) {
    return;
  }

  transcodeSavingsTotals.attemptedFiles += results.length;

  for (const item of results) {
    if (item?.ok !== true) {
      transcodeSavingsTotals.failedFiles += 1;
      continue;
    }

    transcodeSavingsTotals.filesTranscoded += 1;

    if (!Number.isFinite(item?.sourceSizeBytes) || !Number.isFinite(item?.outputSizeBytes)) {
      continue;
    }
    transcodeSavingsTotals.sourceBytes += item.sourceSizeBytes;
    transcodeSavingsTotals.outputBytes += item.outputSizeBytes;
    transcodeSavingsTotals.savedBytes += (item.sourceSizeBytes - item.outputSizeBytes);

    if (item.sourceSizeBytes > 0) {
      const reductionPct = ((item.sourceSizeBytes - item.outputSizeBytes) / item.sourceSizeBytes) * 100;
      if (Number.isFinite(reductionPct)) {
        transcodeSavingsTotals.reductionPctSum += reductionPct;
        transcodeSavingsTotals.reductionPctCount += 1;
      }
    }
  }
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
  resetTranscodeLiveSnapshots();
  broadcastTranscodeEvent('status', `Transcode started for ${files.length} file(s).`);

  const runStartedAtMs = Date.now();
  const runLogPath = makeRunLogPath(runStartedAtMs);

  const fileDiagnostics = await Promise.all(files.map(async (filePath) => {
    const resolved = path.resolve(String(filePath || ''));
    try {
      const stat = await fs.stat(resolved);
      return {
        file: resolved,
        exists: stat.isFile(),
        sizeBytes: stat.size,
        mtime: stat.mtime?.toISOString?.() || null
      };
    } catch (error) {
      return {
        file: resolved,
        exists: false,
        error: error.message
      };
    }
  }));

  const queuedDurations = await Promise.all(
    files.map(async (filePath) => {
      const duration = await runFfprobeDuration(filePath).catch(() => null);
      return Number.isFinite(duration) && duration > 0 ? duration : null;
    })
  );

  broadcastTranscodeEvent('queue', JSON.stringify({
    totalFiles: files.length,
    files: files.map((filePath, index) => ({ file: filePath, durationSeconds: queuedDurations[index] }))
  }));

  const results = [];
  const fileAttempts = [];
  let completedFiles = 0;
  const transcodeStartedAtMs = Date.now();

  const emitOverallProgress = ({
    currentFileIndex = null,
    currentProcessedSeconds = 0,
    currentDurationSeconds = null,
    currentSpeed = null,
    currentElapsedSeconds = null
  } = {}) => {
    const knownDurations = queuedDurations.filter((duration) => Number.isFinite(duration) && duration > 0);
    const fallbackAverage = knownDurations.length
      ? (knownDurations.reduce((sum, value) => sum + value, 0) / knownDurations.length)
      : (Number.isFinite(currentDurationSeconds) && currentDurationSeconds > 0 ? currentDurationSeconds : null);

    const estimatedDurations = queuedDurations.map((duration) => {
      if (Number.isFinite(duration) && duration > 0) {
        return duration;
      }
      return Number.isFinite(fallbackAverage) && fallbackAverage > 0 ? fallbackAverage : 0;
    });

    const totalEstimatedSeconds = estimatedDurations.reduce((sum, value) => sum + value, 0);
    const completedEstimatedSeconds = estimatedDurations
      .slice(0, completedFiles)
      .reduce((sum, value) => sum + value, 0);

    const processedContribution = Number.isFinite(currentProcessedSeconds) && currentProcessedSeconds > 0
      ? currentProcessedSeconds
      : 0;
    const doneEstimatedSeconds = Math.max(0, completedEstimatedSeconds + processedContribution);

    const percent = totalEstimatedSeconds > 0
      ? Math.max(0, Math.min(100, (doneEstimatedSeconds / totalEstimatedSeconds) * 100))
      : Math.max(0, Math.min(100, (completedFiles / Math.max(1, files.length)) * 100));

    const remainingEstimatedSeconds = totalEstimatedSeconds > 0
      ? Math.max(0, totalEstimatedSeconds - doneEstimatedSeconds)
      : null;

    const runElapsedSeconds = Math.max(0, (Date.now() - transcodeStartedAtMs) / 1000);
    const averageSpeed = Number.isFinite(doneEstimatedSeconds) && doneEstimatedSeconds > 0 && runElapsedSeconds > 0
      ? (doneEstimatedSeconds / runElapsedSeconds)
      : null;

    const etaSeconds = Number.isFinite(remainingEstimatedSeconds) && Number.isFinite(averageSpeed) && averageSpeed > 0
      ? (remainingEstimatedSeconds / averageSpeed)
      : null;

    const knownCount = knownDurations.length;
    const estimateCoverage = files.length > 0 ? (knownCount / files.length) : 1;
    const estimateConfidence = estimateCoverage >= 0.85
      ? 'high'
      : (estimateCoverage >= 0.45 ? 'medium' : 'low');

    broadcastTranscodeEvent('overall', JSON.stringify({
      percent,
      etaSeconds,
      completedFiles,
      totalFiles: files.length,
      currentFileIndex,
      remainingFiles: Math.max(0, files.length - completedFiles),
      totalEstimatedSeconds: Number.isFinite(totalEstimatedSeconds) && totalEstimatedSeconds > 0 ? totalEstimatedSeconds : null,
      doneEstimatedSeconds,
      averageSpeed: Number.isFinite(averageSpeed) ? averageSpeed : null,
      estimateConfidence,
      estimateCoverage
    }));
  };

  emitOverallProgress();

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
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
    let sourceDurationSeconds = null;
    try {
      if (Number.isFinite(startBatteryThreshold)) {
        const battery = await readBatteryInfo();
        if (!battery.available || !Number.isFinite(battery.percent)) {
          const errorText = `Cannot verify battery for start threshold ${startBatteryThreshold}%.`;
          results.push({ file, output: null, ok: false, error: errorText, logPath: null });
          broadcastTranscodeEvent('status', `Skipped: ${path.basename(file)} (${errorText})`);
          completedFiles += 1;
          emitOverallProgress({ currentFileIndex: fileIndex });
          continue;
        }
        if (battery.percent <= startBatteryThreshold) {
          const errorText = `Battery ${battery.percent}% is not above start threshold ${startBatteryThreshold}%.`;
          results.push({ file, output: null, ok: false, error: errorText, logPath: null });
          broadcastTranscodeEvent('status', `Skipped: ${path.basename(file)} (${errorText})`);
          completedFiles += 1;
          emitOverallProgress({ currentFileIndex: fileIndex });
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
      sourceDurationSeconds = await runFfprobeDuration(workingInput).catch(() => null);
      const commandText = `ffmpeg ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
      ffmpegCommand = commandText;
      broadcastTranscodeEvent('status', `Processing: ${file}`);
      emitTranscodeFileEvent('file-start', {
        file,
        fileIndex,
        totalFiles: files.length
      });
      broadcastTranscodeEvent('log', commandText);
      broadcastTranscodeEvent('progress', JSON.stringify({
        file,
        totalDurationSeconds: sourceDurationSeconds,
        processedSeconds: 0,
        percent: 0,
        etaSeconds: null,
        elapsedSeconds: 0,
        speed: null
      }));
      emitOverallProgress({
        currentFileIndex: fileIndex,
        currentProcessedSeconds: 0,
        currentDurationSeconds: sourceDurationSeconds,
        currentSpeed: null,
        currentElapsedSeconds: 0
      });
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args);
        lastFfmpegProcess = ff;
        lastFfmpegProcessPaused = false;
        const startedAtMs = Date.now();
        let lastProgressEmitMs = 0;
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

          const progress = extractProgressFromChunk(msg);
          if (!progress || !Number.isFinite(progress.processedSeconds)) {
            return;
          }

          const nowMs = Date.now();
          if (nowMs - lastProgressEmitMs < 500) {
            return;
          }
          lastProgressEmitMs = nowMs;

          const processedSeconds = Math.max(0, progress.processedSeconds);
          const elapsedSeconds = Math.max(0, (nowMs - startedAtMs) / 1000);
          const totalDuration = Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0
            ? sourceDurationSeconds
            : null;
          const remainingSeconds = totalDuration ? Math.max(0, totalDuration - processedSeconds) : null;
          let etaSeconds = null;

          if (remainingSeconds !== null) {
            if (Number.isFinite(progress.speed) && progress.speed > 0) {
              etaSeconds = remainingSeconds / progress.speed;
            } else if (processedSeconds > 0 && elapsedSeconds > 0) {
              etaSeconds = remainingSeconds * (elapsedSeconds / processedSeconds);
            }
          }

          const percent = totalDuration
            ? Math.max(0, Math.min(100, (processedSeconds / totalDuration) * 100))
            : null;

          broadcastTranscodeEvent('progress', JSON.stringify({
            file,
            totalDurationSeconds: totalDuration,
            processedSeconds,
            percent,
            etaSeconds,
            elapsedSeconds,
            speed: progress.speed
          }));
          emitOverallProgress({
            currentFileIndex: fileIndex,
            currentProcessedSeconds: processedSeconds,
            currentDurationSeconds: totalDuration,
            currentSpeed: progress.speed,
            currentElapsedSeconds: elapsedSeconds
          });
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
            emitTranscodeFileEvent('file-complete', {
              file,
              output: origOutput,
              ok: true,
              deletedOriginal: false,
              warning: `Transcoded, but failed to delete original: ${delErr.message}`,
              logPath: perFileLogPath
            });
            continue;
          }
        }
        results.push({ file, output: origOutput, ok: true, logPath: perFileLogPath });
        emitTranscodeFileEvent('file-complete', {
          file,
          output: origOutput,
          ok: true,
          deletedOriginal: deleteOriginal === true,
          logPath: perFileLogPath
        });
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
            emitTranscodeFileEvent('file-complete', {
              file,
              output: workingOutput,
              ok: true,
              deletedOriginal: false,
              warning: `Transcoded, but failed to delete original: ${delErr.message}`,
              logPath: perFileLogPath
            });
            continue;
          }
        }
        results.push({ file, output: workingOutput, ok: true, logPath: perFileLogPath });
        emitTranscodeFileEvent('file-complete', {
          file,
          output: workingOutput,
          ok: true,
          deletedOriginal: deleteOriginal === true,
          logPath: perFileLogPath
        });
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

      if (Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0) {
        broadcastTranscodeEvent('progress', JSON.stringify({
          file,
          totalDurationSeconds: sourceDurationSeconds,
          processedSeconds: sourceDurationSeconds,
          percent: 100,
          etaSeconds: 0,
          elapsedSeconds: null,
          speed: null
        }));
      }
      completedFiles += 1;
      emitOverallProgress({ currentFileIndex: fileIndex });

      fileAttempts.push({
        file,
        status: 'success',
        ffmpegCommand,
        ffmpegStdout,
        ffmpegStderr,
        outputPath: finalOutputPath || workingOutput || null,
        perFileLogPath
      });
    } catch (err) {
      results.push({ file, output: workingOutput, ok: false, error: err.message, logPath: perFileLogPath });
      emitTranscodeFileEvent('file-failed', {
        file,
        output: workingOutput || null,
        ok: false,
        error: err.message,
        logPath: perFileLogPath
      });
      broadcastTranscodeEvent('log', `ERROR ${file}: ${err.message}`);

      const fallbackOutput = finalOutputPath || workingOutput || buildOutputPath(file, { videoCodec, audioCodec });
      const targetFailLogPath = buildFailLogPathFromOutput(fallbackOutput);
      perFileLogPath = targetFailLogPath;
      try {
        await writePerFileTranscodeLog({
          logPath: targetFailLogPath,
          sourcePath: file,
          outputPath: finalOutputPath,
          ffmpegCommand,
          ffmpegStdout,
          ffmpegStderr,
          status: 'failed',
          errorMessage: err.message
        });
        for (let i = results.length - 1; i >= 0; i -= 1) {
          if (results[i].file === file) {
            results[i].logPath = perFileLogPath;
            break;
          }
        }
      } catch (logError) {
        broadcastTranscodeEvent('log', `ERROR writing fail log for ${file}: ${logError.message || 'unknown error'}`);
      }

      // Clean up temp files if error
      if (tempInput) { try { await fs.unlink(tempInput); } catch {} }
      if (tempOutput) { try { await fs.unlink(tempOutput); } catch {} }
      completedFiles += 1;
      emitOverallProgress({ currentFileIndex: fileIndex });

      fileAttempts.push({
        file,
        status: 'failed',
        error: err.message,
        ffmpegCommand,
        ffmpegStdout,
        ffmpegStderr,
        outputPath: finalOutputPath || workingOutput || null,
        perFileLogPath
      });
    }
  }

  emitOverallProgress({ currentFileIndex: null, currentProcessedSeconds: 0, currentDurationSeconds: null, currentSpeed: null, currentElapsedSeconds: null });

  const enrichedResults = await attachSizeStats(results);
  accumulateTranscodeSavings(enrichedResults);
  const savingsSummary = getTranscodeSavingsSummary();

  await writeTranscodeRunLog({
    logPath: runLogPath,
    startedAtMs: runStartedAtMs,
    requestPayload: {
      files,
      videoCodec,
      audioCodec,
      videoBitrate,
      audioChannels,
      deleteOriginal,
      transcodeLocation: safeTranscodeLocation,
      pauseBatteryPct,
      startBatteryPct,
      saveTranscodeLog
    },
    queuedDurations,
    fileDiagnostics,
    fileAttempts,
    results: enrichedResults,
    savingsSummary
  }).catch((error) => {
    broadcastTranscodeEvent('log', `ERROR writing transcode run log: ${error.message}`);
  });

  transcodeInProgress = false;
  latestFileStartPayload = null;
  latestProgressPayloadText = null;
  latestOverallPayloadText = null;
  latestQueuePayloadText = null;
  const failed = enrichedResults.filter(r => !r.ok);
  if (failed.length) {
    broadcastTranscodeEvent('done', 'Transcode finished with errors.');
    const failedFiles = failed.map((item) => item.file);
    const uniqueReasons = Array.from(new Set(
      failed
        .map((item) => (typeof item.error === 'string' ? item.error.trim() : ''))
        .filter(Boolean)
    ));

    const reasonPreview = uniqueReasons.slice(0, 3).join(' | ');
    const errorMessage = uniqueReasons.length
      ? `Transcode failed: ${reasonPreview}${uniqueReasons.length > 3 ? ' | ...' : ''}`
      : `Some files failed: ${failedFiles.join(', ')}`;

    return res.status(500).json({
      ok: false,
      error: errorMessage,
      failedFiles,
      failedReasons: uniqueReasons,
      results: enrichedResults,
      summary: savingsSummary,
      runLogPath
    });
  }
  broadcastTranscodeEvent('done', 'Transcode finished successfully.');
  res.json({ ok: true, message: `Transcoded ${enrichedResults.length} file(s).`, results: enrichedResults, summary: savingsSummary, runLogPath });
};

const transcodeSummary = (_req, res) => {
  res.json({ ok: true, summary: getTranscodeSavingsSummary() });
};

const transcodeState = (_req, res) => {
  res.json({ ok: true, state: getTranscodeLiveState() });
};

// SSE endpoint for streaming ffmpeg output
const transcodeStream = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  transcodeStreamClients.add(res);
  writeSseEvent(res, 'status', transcodeInProgress ? 'Transcode in progress.' : 'Connected. Waiting for transcode.');
  if (transcodeInProgress) {
    if (latestQueuePayloadText) {
      writeSseEvent(res, 'queue', latestQueuePayloadText);
    }
    if (latestOverallPayloadText) {
      writeSseEvent(res, 'overall', latestOverallPayloadText);
    }
    if (latestProgressPayloadText) {
      writeSseEvent(res, 'progress', latestProgressPayloadText);
    }
    if (latestFileStartPayload) {
      writeSseEvent(res, 'file-start', JSON.stringify(latestFileStartPayload));
    }
  }
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

export default { transcode, transcodeStream, transcodeCancel, transcodeSummary, transcodeState };
