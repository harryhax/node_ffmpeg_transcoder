import fs from "fs/promises";

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

export function getTranscodeSavingsSummary() {
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

export async function attachSizeStats(results) {
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

export function accumulateTranscodeSavings(results) {
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
