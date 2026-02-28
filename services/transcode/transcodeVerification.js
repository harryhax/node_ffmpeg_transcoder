import fs from "fs/promises";
import { runFfprobeDuration } from "./transcodeUtils.js";

export async function verifyTranscodeOutput(inputPath, outputPath) {
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