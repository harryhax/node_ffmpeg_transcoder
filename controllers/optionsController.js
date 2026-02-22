import { getCodecOptions, listDirectories } from '../services/optionsService.js';
import path from 'node:path';
import fs from 'node:fs/promises';

const workspaceRoot = path.resolve(process.cwd());

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

export async function getLogFileHandler(req, res) {
  const requestedPath = String(req.query.path || '').trim();
  if (!requestedPath) {
    return res.status(400).send('Missing log path.');
  }

  const resolvedPath = path.resolve(requestedPath);
  const relative = path.relative(workspaceRoot, resolvedPath);
  const insideWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!insideWorkspace) {
    return res.status(400).send('Log path must be inside workspace.');
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== '.log') {
    return res.status(400).send('Only .log files can be opened.');
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      return res.status(404).send('Log file not found.');
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.sendFile(resolvedPath);
  } catch {
    return res.status(404).send('Log file not found.');
  }
}
