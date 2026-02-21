import { getCodecOptions, listDirectories } from '../services/optionsService.js';

export async function getCodecOptionsHandler(_req, res) {
  try {
    const options = await getCodecOptions();
    // Only expose popular/safe codecs for dropdowns
    const allowedVideo = ['h264', 'hevc', 'vp9', 'libx264', 'libx265', 'libvpx-vp9'];
    const allowedAudio = ['aac', 'ac3', 'opus', 'libopus'];
    const videoCodecs = options.videoCodecs.filter(c => allowedVideo.includes(c));
    const audioCodecs = options.audioCodecs.filter(c => allowedAudio.includes(c));
    res.json({ ok: true, videoCodecs, audioCodecs });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

export async function getDirectoriesHandler(req, res) {
  const base = req.query.base || '.';
  const maxDepthRaw = Number.parseInt(req.query.maxDepth || '3', 10);
  const maxDepth = Number.isFinite(maxDepthRaw) && maxDepthRaw >= 0 ? Math.min(maxDepthRaw, 8) : 3;

  try {
    const directories = await listDirectories(base, maxDepth);
    res.json({ ok: true, base, directories });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
}
