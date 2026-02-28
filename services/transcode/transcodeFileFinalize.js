import fs from "fs/promises";
import { buildOutputPath } from "./transcodeUtils.js";

export async function finalizeSuccessfulTranscodeFile({
  file,
  workingOutput,
  verificationInput,
  verificationOutput,
  safeTranscodeLocation,
  tempInput,
  tempOutput,
  deleteOriginal,
  perFileLogPath,
  videoCodec,
  audioCodec,
  results,
  emitTranscodeFileEvent,
  verifyTranscodeOutput,
}) {
  if (safeTranscodeLocation && tempOutput) {
    const origOutput = buildOutputPath(file, { videoCodec, audioCodec });
    await fs.copyFile(tempOutput, origOutput);
    await verifyTranscodeOutput(verificationInput, origOutput);

    await fs.unlink(tempInput);
    await fs.unlink(tempOutput);

    if (deleteOriginal) {
      try {
        await fs.unlink(file);
      } catch (deleteError) {
        const warning = `Transcoded, but failed to delete original: ${deleteError.message}`;
        results.push({
          file,
          output: origOutput,
          ok: true,
          warning,
          logPath: perFileLogPath,
        });
        emitTranscodeFileEvent("file-complete", {
          file,
          output: origOutput,
          ok: true,
          deletedOriginal: false,
          warning,
          logPath: perFileLogPath,
        });
        return { finalOutputPath: origOutput, shouldSkipRemainingSuccessFlow: true };
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

    return { finalOutputPath: origOutput, shouldSkipRemainingSuccessFlow: false };
  }

  await verifyTranscodeOutput(verificationInput, verificationOutput);
  if (deleteOriginal) {
    try {
      await fs.unlink(file);
    } catch (deleteError) {
      const warning = `Transcoded, but failed to delete original: ${deleteError.message}`;
      results.push({
        file,
        output: workingOutput,
        ok: true,
        warning,
        logPath: perFileLogPath,
      });
      emitTranscodeFileEvent("file-complete", {
        file,
        output: workingOutput,
        ok: true,
        deletedOriginal: false,
        warning,
        logPath: perFileLogPath,
      });
      return {
        finalOutputPath: verificationOutput,
        shouldSkipRemainingSuccessFlow: true,
      };
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

  return {
    finalOutputPath: verificationOutput,
    shouldSkipRemainingSuccessFlow: false,
  };
}