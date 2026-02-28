import path from "path";

const transcodeLocationRoot = path.resolve(
  process.env.TRANSCODE_LOCATION_ROOT || process.cwd(),
);

export function resolveTranscodeLocation(inputPath) {
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

export function buildFfmpegArgs(input, output, opts) {
  const args = ["-y", "-i", input];
  if (opts.videoCodec) args.push("-c:v", opts.videoCodec);
  if (opts.videoBitrate) args.push("-b:v", `${opts.videoBitrate}k`);
  if (opts.audioCodec) args.push("-c:a", opts.audioCodec);
  if (opts.audioBitrate) args.push("-b:a", `${opts.audioBitrate}k`);
  if (opts.audioChannels) args.push("-ac", opts.audioChannels);
  args.push(output);
  return args;
}

export function resolveEffectiveBitrateKbps(requestedBitrate, sourceBitrateKbps) {
  const requested = Number.parseInt(String(requestedBitrate || "").trim(), 10);
  if (!Number.isFinite(requested) || requested <= 0) {
    return requestedBitrate;
  }
  if (!Number.isFinite(sourceBitrateKbps) || sourceBitrateKbps <= 0) {
    return String(requested);
  }
  return String(Math.min(requested, Math.round(sourceBitrateKbps)));
}
