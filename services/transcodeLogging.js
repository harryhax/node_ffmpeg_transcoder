import path from 'path';
import fs from 'fs/promises';
import { getFfprobeCommand } from './optionsService.js';
import { runCommand } from './transcodeUtils.js';

const transcodeRunLogDir = path.resolve(process.cwd(), 'transcode-logs');

function stringifyForLog(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
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

async function collectFileDetails(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  const ffprobeArgs = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath];
  const ffprobeCommand = getFfprobeCommand();
  const ffprobeResult = await runCommand(ffprobeCommand, ffprobeArgs).catch((error) => ({ code: -1, stdout: '', stderr: error.message }));

  return {
    filePath,
    stat,
    ffprobe: {
      command: formatCommand(ffprobeCommand, ffprobeArgs),
      ...ffprobeResult
    }
  };
}

export function makeRunLogPath(startedAtMs = Date.now()) {
  const stamp = new Date(startedAtMs).toISOString().replace(/[:.]/g, '-');
  return path.join(transcodeRunLogDir, `transcode-run-${stamp}.log`);
}

export async function writeTranscodeRunLog({
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

export async function writePerFileTranscodeLog({
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