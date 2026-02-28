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
import {
  buildFfmpegArgs,
  resolveEffectiveBitrateKbps,
  resolveTranscodeLocation,
} from "../services/transcodePolicy.js";
import {
  accumulateTranscodeSavings,
  attachSizeStats,
  getTranscodeSavingsSummary,
} from "../services/transcodeResults.js";
import { createTranscodeProcessState } from "../services/transcodeProcessState.js";
import { buildOverallProgressSnapshot } from "../services/transcodeProgress.js";
import { verifyTranscodeOutput } from "../services/transcodeVerification.js";
const transcodeStreamState = createTranscodeStreamState();
const transcodeProcessState = createTranscodeProcessState();

function getTranscodeLiveState() {
  return {
    ...transcodeStreamState.getLiveState(transcodeProcessState.isInProgress()),
    paused:
      transcodeProcessState.isInProgress() && transcodeProcessState.isPaused(),
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

  transcodeProcessState.startRun();
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
  } = {}) => {
    const snapshot = buildOverallProgressSnapshot({
      queuedDurations,
      completedFiles,
      totalFiles: files.length,
      transcodeStartedAtMs,
      currentFileIndex,
      currentProcessedSeconds,
      currentDurationSeconds,
    });

    broadcastTranscodeEvent(
      "overall",
      JSON.stringify(snapshot),
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
      if (transcodeProcessState.isCancelRequested()) {
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
      });
      await new Promise((resolve, reject) => {
        const ff = spawn(getFfmpegCommand(), args);
        transcodeProcessState.setProcess(ff);
        const startedAtMs = Date.now();
        let lastProgressEmitMs = 0;
        const stopBatteryMonitor = createBatteryPauseMonitor({
          ffmpegProcess: ff,
          pauseBatteryThreshold,
          isCurrentProcess: () => transcodeProcessState.isCurrentProcess(ff),
          getPaused: () => transcodeProcessState.isPaused(),
          setPaused: (paused) => transcodeProcessState.setPaused(paused),
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
          transcodeProcessState.clearProcess();
          if (code === 0) {
            resolve();
            return;
          }

          if (transcodeProcessState.isCancelRequested()) {
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
      if (err?.isCancelled || transcodeProcessState.isCancelRequested()) {
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

  transcodeProcessState.finishRun();
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
    transcodeProcessState.isInProgress()
      ? "Transcode in progress."
      : "Connected. Waiting for transcode.",
  );
  if (transcodeProcessState.isInProgress()) {
    transcodeStreamState.replayProgressSnapshots(res);
  }
  req.on("close", () => {
    transcodeStreamState.removeClient(res);
  });
};

// Cancel endpoint: kill ffmpeg process
export const transcodeCancel = (req, res) => {
  if (!transcodeProcessState.isInProgress()) {
    return res
      .status(400)
      .json({ ok: false, error: "No transcode in progress." });
  }

  transcodeProcessState.requestCancel();
  broadcastTranscodeEvent(
    "status",
    "Cancellation requested. Current and queued transcodes will stop.",
  );

  if (transcodeProcessState.terminateCurrentProcess()) {
    console.log("Transcode cancelled by user.");
    return res.json({ ok: true, message: "Transcode cancellation requested." });
  }
  return res.json({ ok: true, message: "Transcode cancellation requested." });
};

export const transcodePause = (_req, res) => {
  if (
    !transcodeProcessState.isInProgress() ||
    !transcodeProcessState.hasControllableProcess()
  ) {
    return res
      .status(400)
      .json({ ok: false, error: "No transcode in progress." });
  }

  if (transcodeProcessState.isPaused()) {
    return res.json({
      ok: true,
      paused: true,
      message: "Transcode already paused.",
    });
  }

  try {
    transcodeProcessState.pauseCurrentProcess();
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
  if (
    !transcodeProcessState.isInProgress() ||
    !transcodeProcessState.hasControllableProcess()
  ) {
    return res
      .status(400)
      .json({ ok: false, error: "No transcode in progress." });
  }

  if (!transcodeProcessState.isPaused()) {
    return res.json({
      ok: true,
      paused: false,
      message: "Transcode already running.",
    });
  }

  try {
    transcodeProcessState.resumeCurrentProcess();
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
