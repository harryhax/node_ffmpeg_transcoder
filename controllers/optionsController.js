import { getCodecOptions, listDirectories } from '../services/optionsService.js';

export async function getCodecOptionsHandler(_req, res) {
  try {
    const options = await getCodecOptions();
    res.json({ ok: true, videoCodecs: options.videoCodecs, audioCodecs: options.audioCodecs });
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
