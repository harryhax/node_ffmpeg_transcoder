import path from "path";
import { spawn } from "child_process";
import fs from "fs/promises";
import { getFfmpegCommand } from "../services/optionsService.js";
import {
  createBatteryPauseMonitor,
  normalizePauseBatteryPct,
  normalizeStartBatteryPct,
  readBatteryInfo,
} from "../services/transcodeBattery.js";
import { createTranscodeStreamState } from "../services/transcodeStreamState.js";
import {
  makeRunLogPath,
  writePerFileTranscodeLog,
  writeTranscodeRunLog,
} from "../services/transcodeLogging.js";
import {
  runFfprobeAudioBitrateKbps,
  buildFailLogPathFromOutput,
  buildLogPathFromOutput,
  buildOutputPath,
  extractProgressFromChunk,
  runFfprobeVideoBitrateKbps,
  runFfprobeDuration,
} from "../services/transcodeUtils.js";

const transcodeLocationRoot = path.resolve(
  process.env.TRANSCODE_LOCATION_ROOT || process.cwd(),
);
const transcodeStreamState = createTranscodeStreamState();

function resolveTranscodeLocation(inputPath) {
  if (!inputPath) {
    return null;
  }

  const resolved = path.resolve(String(inputPath));
  const relativeToRoot = path.relative(transcodeLocationRoot, resolved);
  const isInsideRoot =
    relativeToRoot === "" ||
    (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot));

  if (!isInsideRoot) {
    throw new Error(
      `transcodeLocation must be inside ${transcodeLocationRoot}`,
    );
  }

  return resolved;
}

function buildFfmpegArgs(input, output, opts) {
  const args = ["-y", "-i", input];
  if (opts.videoCodec) args.push("-c:v", opts.videoCodec);
  if (opts.videoBitrate) args.push("-b:v", `${opts.videoBitrate}k`);
  if (opts.audioCodec) args.push("-c:a", opts.audioCodec);
  if (opts.audioBitrate) args.push("-b:a", `${opts.audioBitrate}k`);
  if (opts.audioChannels) args.push("-ac", opts.audioChannels);
  args.push(output);
  return args;
}

let transcodeInProgress = false;
let transcodeCancelRequested = false;
let lastFfmpegProcessPaused = false;
const transcodeSavingsTotals = {
  filesTranscoded: 0,
  attemptedFiles: 0,
  failedFiles: 0,
  sourceBytes: 0,
  outputBytes: 0,
  savedBytes: 0,
  reductionPctSum: 0,
  reductionPctCount: 0,
  startedAt: new Date().toISOString(),
};

function getTranscodeSavingsSummary() {
  const attemptedFiles = transcodeSavingsTotals.attemptedFiles;
  const filesTranscoded = transcodeSavingsTotals.filesTranscoded;
  const failedFiles = transcodeSavingsTotals.failedFiles;
  const successRatePct =
    attemptedFiles > 0 ? (filesTranscoded / attemptedFiles) * 100 : 0;
  const avgReductionPct =
    transcodeSavingsTotals.reductionPctCount > 0
      ? transcodeSavingsTotals.reductionPctSum /
        transcodeSavingsTotals.reductionPctCount
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
    startedAt: transcodeSavingsTotals.startedAt,
  };
}

function resolveEffectiveBitrateKbps(requestedBitrate, sourceBitrateKbps) {
  const requested = Number.parseInt(String(requestedBitrate || "").trim(), 10);
  if (!Number.isFinite(requested) || requested <= 0) {
    return requestedBitrate;
  }
  if (!Number.isFinite(sourceBitrateKbps) || sourceBitrateKbps <= 0) {
    return String(requested);
  }
  return String(Math.min(requested, Math.round(sourceBitrateKbps)));
}

function getTranscodeLiveState() {
  return {
    ...transcodeStreamState.getLiveState(transcodeInProgress),
    paused: transcodeInProgress === true && lastFfmpegProcessPaused === true,
  };
}

function resetTranscodeLiveSnapshots() {
  transcodeStreamState.resetAllSnapshots();
}

function broadcastTranscodeEvent(event, payload) {
  transcodeStreamState.broadcastEvent(event, payload);
}

function emitTranscodeFileEvent(event, payload) {
  transcodeStreamState.emitFileEvent(event, payload);
}

async function verifyTranscodeOutput(inputPath, outputPath) {
  const outputStat = await fs.stat(outputPath);
  if (!outputStat.isFile() || outputStat.size <= 0) {
    throw new Error("Output file missing or empty after transcode.");
  }

  const [inputDuration, outputDuration] = await Promise.all([
    runFfprobeDuration(inputPath),
    runFfprobeDuration(outputPath),
  ]);

  if (!Number.isFinite(inputDuration) || !Number.isFinite(outputDuration)) {
    return;
  }

  const durationDiff = Math.abs(inputDuration - outputDuration);
  const toleranceSeconds = Math.max(2, inputDuration * 0.05);
  if (durationDiff > toleranceSeconds) {
    throw new Error(
      `Output duration differs too much from input (input=${inputDuration.toFixed(2)}s output=${outputDuration.toFixed(2)}s).`,
    );
  }
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
  return Promise.all(
    results.map(async (item) => {
      const sourceSizeBytes = await readFileSizeSafe(item.file);
      const outputSizeBytes = await readFileSizeSafe(item.output);
      const bytesSaved =
        Number.isFinite(sourceSizeBytes) && Number.isFinite(outputSizeBytes)
          ? sourceSizeBytes - outputSizeBytes
          : null;

      return {
        ...item,
        sourceSizeBytes,
        outputSizeBytes,
        bytesSaved,
      };
    }),
  );
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

    if (
      !Number.isFinite(item?.sourceSizeBytes) ||
      !Number.isFinite(item?.outputSizeBytes)
    ) {
      continue;
    }
    transcodeSavingsTotals.sourceBytes += item.sourceSizeBytes;
    transcodeSavingsTotals.outputBytes += item.outputSizeBytes;
    transcodeSavingsTotals.savedBytes +=
      item.sourceSizeBytes - item.outputSizeBytes;

    if (item.sourceSizeBytes > 0) {
      const reductionPct =
        ((item.sourceSizeBytes - item.outputSizeBytes) / item.sourceSizeBytes) *
        100;
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
  const {
    files,
    videoCodec,
    audioCodec,
    audioBitrate,
    videoBitrate,
    audioChannels,
    deleteOriginal,
    transcodeLocation,
    pauseBatteryPct,
    startBatteryPct,
    saveTranscodeLog,
    capBitrateToSource,
  } = req.body;
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ ok: false, error: "No files provided." });
  }

  const shouldCapBitrateToSource =
    capBitrateToSource !== false && capBitrateToSource !== "false";

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
      error:
        "Start battery percent must be greater than pause battery percent.",
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
  transcodeCancelRequested = false;
  resetTranscodeLiveSnapshots();
  broadcastTranscodeEvent(
    "status",
    `Transcode started for ${files.length} file(s).`,
  );

  const runStartedAtMs = Date.now();
  const runLogPath = makeRunLogPath(runStartedAtMs);

  const fileDiagnostics = await Promise.all(
    files.map(async (filePath) => {
      const resolved = path.resolve(String(filePath || ""));
      try {
        const stat = await fs.stat(resolved);
        return {
          file: resolved,
          exists: stat.isFile(),
          sizeBytes: stat.size,
          mtime: stat.mtime?.toISOString?.() || null,
        };
      } catch (error) {
        return {
          file: resolved,
          exists: false,
          error: error.message,
        };
      }
    }),
  );

  const queuedDurations = await Promise.all(
    files.map(async (filePath) => {
      const duration = await runFfprobeDuration(filePath).catch(() => null);
      return Number.isFinite(duration) && duration > 0 ? duration : null;
    }),
  );

  broadcastTranscodeEvent(
    "queue",
    JSON.stringify({
      totalFiles: files.length,
      files: files.map((filePath, index) => ({
        file: filePath,
        durationSeconds: queuedDurations[index],
      })),
    }),
  );

  const results = [];
  const fileAttempts = [];
  let completedFiles = 0;
  const transcodeStartedAtMs = Date.now();

  const emitOverallProgress = ({
    currentFileIndex = null,
    currentProcessedSeconds = 0,
    currentDurationSeconds = null,
    currentSpeed = null,
    currentElapsedSeconds = null,
  } = {}) => {
    const knownDurations = queuedDurations.filter(
      (duration) => Number.isFinite(duration) && duration > 0,
    );
    const fallbackAverage = knownDurations.length
      ? knownDurations.reduce((sum, value) => sum + value, 0) /
        knownDurations.length
      : Number.isFinite(currentDurationSeconds) && currentDurationSeconds > 0
        ? currentDurationSeconds
        : null;

    const estimatedDurations = queuedDurations.map((duration) => {
      if (Number.isFinite(duration) && duration > 0) {
        return duration;
      }
      return Number.isFinite(fallbackAverage) && fallbackAverage > 0
        ? fallbackAverage
        : 0;
    });

    const totalEstimatedSeconds = estimatedDurations.reduce(
      (sum, value) => sum + value,
      0,
    );
    const completedEstimatedSeconds = estimatedDurations
      .slice(0, completedFiles)
      .reduce((sum, value) => sum + value, 0);

    const processedContribution =
      Number.isFinite(currentProcessedSeconds) && currentProcessedSeconds > 0
        ? currentProcessedSeconds
        : 0;
    const doneEstimatedSeconds = Math.max(
      0,
      completedEstimatedSeconds + processedContribution,
    );

    const percent =
      totalEstimatedSeconds > 0
        ? Math.max(
            0,
            Math.min(100, (doneEstimatedSeconds / totalEstimatedSeconds) * 100),
          )
        : Math.max(
            0,
            Math.min(100, (completedFiles / Math.max(1, files.length)) * 100),
          );

    const remainingEstimatedSeconds =
      totalEstimatedSeconds > 0
        ? Math.max(0, totalEstimatedSeconds - doneEstimatedSeconds)
        : null;

    const runElapsedSeconds = Math.max(
      0,
      (Date.now() - transcodeStartedAtMs) / 1000,
    );
    const averageSpeed =
      Number.isFinite(doneEstimatedSeconds) &&
      doneEstimatedSeconds > 0 &&
      runElapsedSeconds > 0
        ? doneEstimatedSeconds / runElapsedSeconds
        : null;

    const etaSeconds =
      Number.isFinite(remainingEstimatedSeconds) &&
      Number.isFinite(averageSpeed) &&
      averageSpeed > 0
        ? remainingEstimatedSeconds / averageSpeed
        : null;

    const knownCount = knownDurations.length;
    const estimateCoverage = files.length > 0 ? knownCount / files.length : 1;
    const estimateConfidence =
      estimateCoverage >= 0.85
        ? "high"
        : estimateCoverage >= 0.45
          ? "medium"
          : "low";

    broadcastTranscodeEvent(
      "overall",
      JSON.stringify({
        percent,
        etaSeconds,
        completedFiles,
        totalFiles: files.length,
        currentFileIndex,
        remainingFiles: Math.max(0, files.length - completedFiles),
        totalEstimatedSeconds:
          Number.isFinite(totalEstimatedSeconds) && totalEstimatedSeconds > 0
            ? totalEstimatedSeconds
            : null,
        doneEstimatedSeconds,
        averageSpeed: Number.isFinite(averageSpeed) ? averageSpeed : null,
        estimateConfidence,
        estimateCoverage,
      }),
    );
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
    let ffmpegStdout = "";
    let ffmpegStderr = "";
    let ffmpegCommand = "";
    let finalOutputPath = null;
    let perFileLogPath = null;
    let sourceDurationSeconds = null;
    try {
      if (transcodeCancelRequested) {
        broadcastTranscodeEvent(
          "status",
          "Cancellation requested. Stopping remaining transcode queue.",
        );
        break;
      }

      if (Number.isFinite(startBatteryThreshold)) {
        const battery = await readBatteryInfo();
        if (!battery.available || !Number.isFinite(battery.percent)) {
          const errorText = `Cannot verify battery for start threshold ${startBatteryThreshold}%.`;
          results.push({
            file,
            output: null,
            ok: false,
            error: errorText,
            logPath: null,
          });
          broadcastTranscodeEvent(
            "status",
            `Skipped: ${path.basename(file)} (${errorText})`,
          );
          completedFiles += 1;
          emitOverallProgress({ currentFileIndex: fileIndex });
          continue;
        }
        if (battery.percent <= startBatteryThreshold) {
          const errorText = `Battery ${battery.percent}% is not above start threshold ${startBatteryThreshold}%.`;
          results.push({
            file,
            output: null,
            ok: false,
            error: errorText,
            logPath: null,
          });
          broadcastTranscodeEvent(
            "status",
            `Skipped: ${path.basename(file)} (${errorText})`,
          );
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
      const requestedVideoBitrateKbps = Number.parseInt(
        String(videoBitrate || "").trim(),
        10,
      );
      const requestedAudioBitrateKbps = Number.parseInt(
        String(audioBitrate || "").trim(),
        10,
      );
      const sourceVideoBitrateKbps =
        shouldCapBitrateToSource &&
        Number.isFinite(requestedVideoBitrateKbps) &&
        requestedVideoBitrateKbps > 0
          ? await runFfprobeVideoBitrateKbps(workingInput).catch(() => null)
          : null;
      const sourceAudioBitrateKbps = shouldCapBitrateToSource
        ? await runFfprobeAudioBitrateKbps(workingInput).catch(() => null)
        : null;
      const effectiveVideoBitrate = shouldCapBitrateToSource
        ? resolveEffectiveBitrateKbps(videoBitrate, sourceVideoBitrateKbps)
        : videoBitrate;
      const effectiveAudioBitrate = shouldCapBitrateToSource
        ? Number.isFinite(requestedAudioBitrateKbps) &&
          requestedAudioBitrateKbps > 0
          ? resolveEffectiveBitrateKbps(audioBitrate, sourceAudioBitrateKbps)
          : Number.isFinite(sourceAudioBitrateKbps) &&
              sourceAudioBitrateKbps > 0
            ? String(Math.round(sourceAudioBitrateKbps))
            : audioBitrate
        : audioBitrate;
      if (
        shouldCapBitrateToSource &&
        Number.isFinite(sourceVideoBitrateKbps) &&
        requestedVideoBitrateKbps > sourceVideoBitrateKbps
      ) {
        broadcastTranscodeEvent(
          "status",
          `Capping bitrate for ${path.basename(file)} to source rate ${Math.round(sourceVideoBitrateKbps)}k (requested ${videoBitrate}k).`,
        );
      }
      if (
        shouldCapBitrateToSource &&
        Number.isFinite(sourceAudioBitrateKbps) &&
        requestedAudioBitrateKbps > sourceAudioBitrateKbps
      ) {
        broadcastTranscodeEvent(
          "status",
          `Capping audio bitrate for ${path.basename(file)} to source rate ${Math.round(sourceAudioBitrateKbps)}k (requested ${audioBitrate}k).`,
        );
      }
      if (
        shouldCapBitrateToSource &&
        (!Number.isFinite(requestedAudioBitrateKbps) ||
          requestedAudioBitrateKbps <= 0) &&
        Number.isFinite(sourceAudioBitrateKbps) &&
        sourceAudioBitrateKbps > 0
      ) {
        broadcastTranscodeEvent(
          "status",
          `Using source audio bitrate ${Math.round(sourceAudioBitrateKbps)}k for ${path.basename(file)} to avoid upscaling.`,
        );
      }
      const args = buildFfmpegArgs(workingInput, workingOutput, {
        videoCodec,
        audioCodec,
        videoBitrate: effectiveVideoBitrate,
        audioBitrate: effectiveAudioBitrate,
        audioChannels,
      });
      sourceDurationSeconds = await runFfprobeDuration(workingInput).catch(
        () => null,
      );
      const ffmpegCommandPath = getFfmpegCommand();
      const commandText = `${ffmpegCommandPath} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
      ffmpegCommand = commandText;
      broadcastTranscodeEvent("status", `Processing: ${file}`);
      emitTranscodeFileEvent("file-start", {
        file,
        fileIndex,
        totalFiles: files.length,
      });
      broadcastTranscodeEvent("log", commandText);
      broadcastTranscodeEvent(
        "progress",
        JSON.stringify({
          file,
          totalDurationSeconds: sourceDurationSeconds,
          processedSeconds: 0,
          percent: 0,
          etaSeconds: null,
          elapsedSeconds: 0,
          speed: null,
        }),
      );
      emitOverallProgress({
        currentFileIndex: fileIndex,
        currentProcessedSeconds: 0,
        currentDurationSeconds: sourceDurationSeconds,
        currentSpeed: null,
        currentElapsedSeconds: 0,
      });
      await new Promise((resolve, reject) => {
        const ff = spawn(getFfmpegCommand(), args);
        lastFfmpegProcess = ff;
        lastFfmpegProcessPaused = false;
        const startedAtMs = Date.now();
        let lastProgressEmitMs = 0;
        const stopBatteryMonitor = createBatteryPauseMonitor({
          ffmpegProcess: ff,
          pauseBatteryThreshold,
          isCurrentProcess: () =>
            !!lastFfmpegProcess && lastFfmpegProcess === ff,
          getPaused: () => lastFfmpegProcessPaused,
          setPaused: (paused) => {
            lastFfmpegProcessPaused = paused;
          },
          onStatus: (message) => {
            broadcastTranscodeEvent("status", message);
          },
        });
        let stderr = "";
        ff.stderr.on("data", (d) => {
          const msg = d.toString();
          stderr += msg;
          ffmpegStderr += msg;
          broadcastTranscodeEvent("log", msg);

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
          const totalDuration =
            Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0
              ? sourceDurationSeconds
              : null;
          const remainingSeconds = totalDuration
            ? Math.max(0, totalDuration - processedSeconds)
            : null;
          let etaSeconds = null;

          if (remainingSeconds !== null) {
            if (Number.isFinite(progress.speed) && progress.speed > 0) {
              etaSeconds = remainingSeconds / progress.speed;
            } else if (processedSeconds > 0 && elapsedSeconds > 0) {
              etaSeconds =
                remainingSeconds * (elapsedSeconds / processedSeconds);
            }
          }

          const percent = totalDuration
            ? Math.max(
                0,
                Math.min(100, (processedSeconds / totalDuration) * 100),
              )
            : null;

          broadcastTranscodeEvent(
            "progress",
            JSON.stringify({
              file,
              totalDurationSeconds: totalDuration,
              processedSeconds,
              percent,
              etaSeconds,
              elapsedSeconds,
              speed: progress.speed,
            }),
          );
          emitOverallProgress({
            currentFileIndex: fileIndex,
            currentProcessedSeconds: processedSeconds,
            currentDurationSeconds: totalDuration,
            currentSpeed: progress.speed,
            currentElapsedSeconds: elapsedSeconds,
          });
        });
        ff.stdout &&
          ff.stdout.on("data", (d) => {
            const msg = d.toString();
            ffmpegStdout += msg;
            broadcastTranscodeEvent("log", msg);
          });
        ff.on("close", (code) => {
          if (stopBatteryMonitor) {
            stopBatteryMonitor();
          }
          lastFfmpegProcess = null;
          lastFfmpegProcessPaused = false;
          if (code === 0) {
            resolve();
            return;
          }

          if (transcodeCancelRequested) {
            const cancelError = new Error("Transcode cancelled by user.");
            cancelError.isCancelled = true;
            reject(cancelError);
            return;
          }

          reject(new Error(stderr || `ffmpeg exited with code ${code}`));
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
            // console.log(`Deleting original file: ${file}`);
            await fs.unlink(file);
          } catch (delErr) {
            results.push({
              file,
              output: origOutput,
              ok: true,
              warning: `Transcoded, but failed to delete original: ${delErr.message}`,
              logPath: perFileLogPath,
            });
            emitTranscodeFileEvent("file-complete", {
              file,
              output: origOutput,
              ok: true,
              deletedOriginal: false,
              warning: `Transcoded, but failed to delete original: ${delErr.message}`,
              logPath: perFileLogPath,
            });
            continue;
          }
        }
        results.push({
          file,
          output: origOutput,
          ok: true,
          logPath: perFileLogPath,
        });
        emitTranscodeFileEvent("file-complete", {
          file,
          output: origOutput,
          ok: true,
          deletedOriginal: deleteOriginal === true,
          logPath: perFileLogPath,
        });
      } else {
        finalOutputPath = verificationOutput;
        await verifyTranscodeOutput(verificationInput, verificationOutput);
        // No transcodeLocation, just handle output in place
        if (deleteOriginal) {
          try {
            //   console.log(`Deleting original file: ${file}`);
            await fs.unlink(file);
          } catch (delErr) {
            results.push({
              file,
              output: workingOutput,
              ok: true,
              warning: `Transcoded, but failed to delete original: ${delErr.message}`,
              logPath: perFileLogPath,
            });
            emitTranscodeFileEvent("file-complete", {
              file,
              output: workingOutput,
              ok: true,
              deletedOriginal: false,
              warning: `Transcoded, but failed to delete original: ${delErr.message}`,
              logPath: perFileLogPath,
            });
            continue;
          }
        }
        results.push({
          file,
          output: workingOutput,
          ok: true,
          logPath: perFileLogPath,
        });
        emitTranscodeFileEvent("file-complete", {
          file,
          output: workingOutput,
          ok: true,
          deletedOriginal: deleteOriginal === true,
          logPath: perFileLogPath,
        });
      }

      if (saveTranscodeLog === true || saveTranscodeLog === "true") {
        const targetLogPath = buildLogPathFromOutput(
          finalOutputPath || buildOutputPath(file, { videoCodec, audioCodec }),
        );
        perFileLogPath = targetLogPath;
        await writePerFileTranscodeLog({
          logPath: targetLogPath,
          sourcePath: file,
          outputPath: finalOutputPath,
          ffmpegCommand,
          ffmpegStdout,
          ffmpegStderr,
          status: "success",
        });
        for (let i = results.length - 1; i >= 0; i -= 1) {
          if (results[i].file === file && !results[i].logPath) {
            results[i].logPath = perFileLogPath;
            break;
          }
        }
      }

      if (Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0) {
        broadcastTranscodeEvent(
          "progress",
          JSON.stringify({
            file,
            totalDurationSeconds: sourceDurationSeconds,
            processedSeconds: sourceDurationSeconds,
            percent: 100,
            etaSeconds: 0,
            elapsedSeconds: null,
            speed: null,
          }),
        );
      }
      completedFiles += 1;
      emitOverallProgress({ currentFileIndex: fileIndex });

      fileAttempts.push({
        file,
        status: "success",
        ffmpegCommand,
        ffmpegStdout,
        ffmpegStderr,
        outputPath: finalOutputPath || workingOutput || null,
        perFileLogPath,
      });
    } catch (err) {
      if (err?.isCancelled || transcodeCancelRequested) {
        const cancelMessage = "Transcode cancelled by user.";
        results.push({
          file,
          output: workingOutput,
          ok: false,
          error: cancelMessage,
          logPath: perFileLogPath,
        });
        emitTranscodeFileEvent("file-failed", {
          file,
          output: workingOutput || null,
          ok: false,
          error: cancelMessage,
          logPath: perFileLogPath,
        });
        broadcastTranscodeEvent(
          "status",
          "Cancellation requested. Stopping remaining transcode queue.",
        );

        completedFiles += 1;
        emitOverallProgress({ currentFileIndex: fileIndex });

        fileAttempts.push({
          file,
          status: "cancelled",
          error: cancelMessage,
          ffmpegCommand,
          ffmpegStdout,
          ffmpegStderr,
          outputPath: finalOutputPath || workingOutput || null,
          perFileLogPath,
        });
        break;
      }

      results.push({
        file,
        output: workingOutput,
        ok: false,
        error: err.message,
        logPath: perFileLogPath,
      });
      emitTranscodeFileEvent("file-failed", {
        file,
        output: workingOutput || null,
        ok: false,
        error: err.message,
        logPath: perFileLogPath,
      });
      broadcastTranscodeEvent("log", `ERROR ${file}: ${err.message}`);

      const fallbackOutput =
        finalOutputPath ||
        workingOutput ||
        buildOutputPath(file, { videoCodec, audioCodec });
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
          status: "failed",
          errorMessage: err.message,
        });
        for (let i = results.length - 1; i >= 0; i -= 1) {
          if (results[i].file === file) {
            results[i].logPath = perFileLogPath;
            break;
          }
        }
      } catch (logError) {
        broadcastTranscodeEvent(
          "log",
          `ERROR writing fail log for ${file}: ${logError.message || "unknown error"}`,
        );
      }

      // Clean up temp files if error
      if (tempInput) {
        try {
          await fs.unlink(tempInput);
        } catch {}
      }
      if (tempOutput) {
        try {
          await fs.unlink(tempOutput);
        } catch {}
      }
      completedFiles += 1;
      emitOverallProgress({ currentFileIndex: fileIndex });

      fileAttempts.push({
        file,
        status: "failed",
        error: err.message,
        ffmpegCommand,
        ffmpegStdout,
        ffmpegStderr,
        outputPath: finalOutputPath || workingOutput || null,
        perFileLogPath,
      });
    }
  }

  emitOverallProgress({
    currentFileIndex: null,
    currentProcessedSeconds: 0,
    currentDurationSeconds: null,
    currentSpeed: null,
    currentElapsedSeconds: null,
  });

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
      audioBitrate,
      videoBitrate,
      audioChannels,
      deleteOriginal,
      transcodeLocation: safeTranscodeLocation,
      pauseBatteryPct,
      startBatteryPct,
      saveTranscodeLog,
      capBitrateToSource: shouldCapBitrateToSource,
    },
    queuedDurations,
    fileDiagnostics,
    fileAttempts,
    results: enrichedResults,
    savingsSummary,
  }).catch((error) => {
    broadcastTranscodeEvent(
      "log",
      `ERROR writing transcode run log: ${error.message}`,
    );
  });

  transcodeInProgress = false;
  transcodeCancelRequested = false;
  transcodeStreamState.clearProgressSnapshots();

  if (fileAttempts.some((attempt) => attempt.status === "cancelled")) {
    broadcastTranscodeEvent("done", "Transcode cancelled.");
    return res.json({
      ok: true,
      cancelled: true,
      message: `Transcode cancelled. Completed ${completedFiles} of ${files.length} file(s).`,
      results: enrichedResults,
      summary: savingsSummary,
      runLogPath,
    });
  }

  const failed = enrichedResults.filter((r) => !r.ok);
  if (failed.length) {
    broadcastTranscodeEvent("done", "Transcode finished with errors.");
    const failedFiles = failed.map((item) => item.file);
    const uniqueReasons = Array.from(
      new Set(
        failed
          .map((item) =>
            typeof item.error === "string" ? item.error.trim() : "",
          )
          .filter(Boolean),
      ),
    );

    const reasonPreview = uniqueReasons.slice(0, 3).join(" | ");
    const errorMessage = uniqueReasons.length
      ? `Transcode failed: ${reasonPreview}${uniqueReasons.length > 3 ? " | ..." : ""}`
      : `Some files failed: ${failedFiles.join(", ")}`;

    return res.status(500).json({
      ok: false,
      error: errorMessage,
      failedFiles,
      failedReasons: uniqueReasons,
      results: enrichedResults,
      summary: savingsSummary,
      runLogPath,
    });
  }
  broadcastTranscodeEvent("done", "Transcode finished successfully.");
  res.json({
    ok: true,
    message: `Transcoded ${enrichedResults.length} file(s).`,
    results: enrichedResults,
    summary: savingsSummary,
    runLogPath,
  });
};

const transcodeSummary = (_req, res) => {
  res.json({ ok: true, summary: getTranscodeSavingsSummary() });
};

const transcodeState = (_req, res) => {
  res.json({ ok: true, state: getTranscodeLiveState() });
};

// SSE endpoint for streaming ffmpeg output
const transcodeStream = (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  transcodeStreamState.addClient(res);
  transcodeStreamState.writeSseEvent(
    res,
    "status",
    transcodeInProgress
      ? "Transcode in progress."
      : "Connected. Waiting for transcode.",
  );
  if (transcodeInProgress) {
    transcodeStreamState.replayProgressSnapshots(res);
  }
  req.on("close", () => {
    transcodeStreamState.removeClient(res);
  });
};

// Cancel endpoint: kill ffmpeg process
export const transcodeCancel = (req, res) => {
  if (!transcodeInProgress) {
    return res
      .status(400)
      .json({ ok: false, error: "No transcode in progress." });
  }

  transcodeCancelRequested = true;
  broadcastTranscodeEvent(
    "status",
    "Cancellation requested. Current and queued transcodes will stop.",
  );

  if (lastFfmpegProcess && lastFfmpegProcess.kill) {
    if (lastFfmpegProcessPaused) {
      try {
        lastFfmpegProcess.kill("SIGCONT");
      } catch {}
    }
    lastFfmpegProcess.kill("SIGTERM");
    lastFfmpegProcessPaused = false;
    console.log("Transcode cancelled by user.");
    return res.json({ ok: true, message: "Transcode cancellation requested." });
  }
  return res.json({ ok: true, message: "Transcode cancellation requested." });
};

export const transcodePause = (_req, res) => {
  if (!transcodeInProgress || !lastFfmpegProcess || !lastFfmpegProcess.kill) {
    return res
      .status(400)
      .json({ ok: false, error: "No transcode in progress." });
  }

  if (lastFfmpegProcessPaused) {
    return res.json({
      ok: true,
      paused: true,
      message: "Transcode already paused.",
    });
  }

  try {
    lastFfmpegProcess.kill("SIGSTOP");
    lastFfmpegProcessPaused = true;
    broadcastTranscodeEvent("status", "Paused: manually paused by user.");
    return res.json({ ok: true, paused: true, message: "Transcode paused." });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Failed to pause transcode.",
    });
  }
};

export const transcodeResume = (_req, res) => {
  if (!transcodeInProgress || !lastFfmpegProcess || !lastFfmpegProcess.kill) {
    return res
      .status(400)
      .json({ ok: false, error: "No transcode in progress." });
  }

  if (!lastFfmpegProcessPaused) {
    return res.json({
      ok: true,
      paused: false,
      message: "Transcode already running.",
    });
  }

  try {
    lastFfmpegProcess.kill("SIGCONT");
    lastFfmpegProcessPaused = false;
    broadcastTranscodeEvent("status", "Resumed: manually resumed by user.");
    return res.json({ ok: true, paused: false, message: "Transcode resumed." });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || "Failed to resume transcode.",
    });
  }
};

export default {
  transcode,
  transcodeStream,
  transcodeCancel,
  transcodePause,
  transcodeResume,
  transcodeSummary,
  transcodeState,
};
