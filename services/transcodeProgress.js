export function buildOverallProgressSnapshot({
  queuedDurations,
  completedFiles,
  totalFiles,
  transcodeStartedAtMs,
  currentFileIndex = null,
  currentProcessedSeconds = 0,
  currentDurationSeconds = null,
}) {
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
          Math.min(100, (completedFiles / Math.max(1, totalFiles)) * 100),
        );

  const remainingEstimatedSeconds =
    totalEstimatedSeconds > 0
      ? Math.max(0, totalEstimatedSeconds - doneEstimatedSeconds)
      : null;

  const runElapsedSeconds = Math.max(0, (Date.now() - transcodeStartedAtMs) / 1000);
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
  const estimateCoverage = totalFiles > 0 ? knownCount / totalFiles : 1;
  const estimateConfidence =
    estimateCoverage >= 0.85
      ? "high"
      : estimateCoverage >= 0.45
        ? "medium"
        : "low";

  return {
    percent,
    etaSeconds,
    completedFiles,
    totalFiles,
    currentFileIndex,
    remainingFiles: Math.max(0, totalFiles - completedFiles),
    totalEstimatedSeconds:
      Number.isFinite(totalEstimatedSeconds) && totalEstimatedSeconds > 0
        ? totalEstimatedSeconds
        : null,
    doneEstimatedSeconds,
    averageSpeed: Number.isFinite(averageSpeed) ? averageSpeed : null,
    estimateConfidence,
    estimateCoverage,
  };
}