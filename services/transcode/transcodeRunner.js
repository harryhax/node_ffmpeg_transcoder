import { spawn } from "child_process";
import { getFfmpegCommand } from "../options/optionsService.js";
import { createBatteryPauseMonitor } from "./transcodeBattery.js";
import { extractProgressFromChunk } from "./transcodeUtils.js";

export function runFfmpegTranscodeProcess({
  args,
  file,
  fileIndex,
  sourceDurationSeconds,
  pauseBatteryThreshold,
  transcodeProcessState,
  broadcastTranscodeEvent,
  emitOverallProgress,
}) {
  return new Promise((resolve, reject) => {
    const ff = spawn(getFfmpegCommand(), args);
    transcodeProcessState.setProcess(ff);

    const startedAtMs = Date.now();
    let lastProgressEmitMs = 0;
    let ffmpegStdout = "";
    let ffmpegStderr = "";

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

    ff.stderr.on("data", (chunk) => {
      const msg = chunk.toString();
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
          etaSeconds = remainingSeconds * (elapsedSeconds / processedSeconds);
        }
      }

      const percent = totalDuration
        ? Math.max(0, Math.min(100, (processedSeconds / totalDuration) * 100))
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
      ff.stdout.on("data", (chunk) => {
        const msg = chunk.toString();
        ffmpegStdout += msg;
        broadcastTranscodeEvent("log", msg);
      });

    ff.on("close", (code) => {
      if (stopBatteryMonitor) {
        stopBatteryMonitor();
      }
      transcodeProcessState.clearProcess();

      if (code === 0) {
        resolve({ ffmpegStdout, ffmpegStderr });
        return;
      }

      if (transcodeProcessState.isCancelRequested()) {
        const cancelError = new Error("Transcode cancelled by user.");
        cancelError.isCancelled = true;
        reject(cancelError);
        return;
      }

      reject(new Error(ffmpegStderr || `ffmpeg exited with code ${code}`));
    });
  });
}