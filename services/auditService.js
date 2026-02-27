import path from 'node:path';
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { inspectWithFallback, normalizeBitrateToBps } from './auditCore.js';
import { getFfprobeCommand } from './optionsService.js';

const VALID_OPERATORS = new Set(['>=', '<=', '=']);

function normalizeOperator(value, fallback = '=') {
  return VALID_OPERATORS.has(value) ? value : fallback;
}

function runAuditInWorker(root, criteria) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/auditWorker.js', import.meta.url), {
      workerData: { root, criteria }
    });

    worker.once('message', (message) => {
      if (!message?.ok) {
        reject(new Error(message?.error || 'Audit worker failed.'));
        return;
      }
      resolve(message.payload);
    });

    worker.once('error', (error) => {
      reject(new Error(`Audit worker error: ${error.message}`));
    });

    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Audit worker exited with code ${code}`));
      }
    });
  });
}

export function buildAuditInput(body = {}) {
  return {
    root: body.root || '.',
    scanExtensions: body.scanExtensions || '',
    videoCodec: body.videoCodec || '',
    videoBitrate: body.videoBitrate || '',
    videoBitrateOp: body.videoBitrateOp || '>=',
    videoBitrateTolerancePct: body.videoBitrateTolerancePct ?? '10',
    audioCodec: body.audioCodec || '',
    audioChannels: body.audioChannels || '',
    audioChannelsOp: body.audioChannelsOp || '>='
  };
}

export function buildCriteria(input) {
  const videoBitrateOp = normalizeOperator(input.videoBitrateOp, '>=');
  const audioChannelsOp = normalizeOperator(input.audioChannelsOp, '>=');

  const criteria = {
    scanExtensions: input.scanExtensions || '',
    videoCodec: input.videoCodec ? String(input.videoCodec).trim().toLowerCase() : undefined,
    videoBitrate: input.videoBitrate ? normalizeBitrateToBps(input.videoBitrate) : undefined,
    videoBitrateOp,
    videoBitrateTolerancePct: Number.parseFloat(input.videoBitrateTolerancePct ?? '10'),
    audioCodec: input.audioCodec ? String(input.audioCodec).trim().toLowerCase() : undefined,
    audioChannels: input.audioChannels ? Number.parseInt(input.audioChannels, 10) : undefined,
    audioChannelsOp,
    ffprobeCommand: getFfprobeCommand()
  };

  if (!Number.isFinite(criteria.videoBitrateTolerancePct) || criteria.videoBitrateTolerancePct < 0 || criteria.videoBitrateTolerancePct > 100) {
    throw new Error('Video bitrate tolerance must be between 0 and 100 percent.');
  }

  if (input.audioChannels && (!Number.isFinite(criteria.audioChannels) || criteria.audioChannels < 1)) {
    throw new Error('Audio channels must be a positive integer.');
  }

  return criteria;
}

async function resolveExistingLogPath(sourcePath) {
  const ext = path.extname(sourcePath);
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, ext);
  const candidates = [
    path.join(dir, `${base}.log`),
    path.join(dir, `${base}.transcoded.log`)
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
    }
  }

  return null;
}

async function mapAuditResultToRow(result, idx, rootPath) {
  const videoBitrateK = Number.isFinite(result.actual?.videoBitrate)
    ? `${Math.round(result.actual.videoBitrate / 1000)}K`
    : 'unknown';

  return {
    sourceStats: {
      sizeBytes: result.file.size,
      modifiedAt: Number.isFinite(result.file.mtimeMs) ? new Date(result.file.mtimeMs).toISOString() : null,
      changedAt: Number.isFinite(result.file.ctimeMs) ? new Date(result.file.ctimeMs).toISOString() : null
    },
    logPath: await resolveExistingLogPath(result.file.path),
    fullPath: result.file.path,
    filePath: path.relative(rootPath, result.file.path) || path.basename(result.file.path),
    fileName: path.basename(result.file.path),
    index: idx + 1,
    rawSize: result.file.size,
    size: result.file.size,
    matches: result.matches,
    checks: result.checks || {},
    issues: result.mismatches.length,
    details: [
      `source file stats: size=${result.file.size} bytes, mtime=${Number.isFinite(result.file.mtimeMs) ? new Date(result.file.mtimeMs).toISOString() : 'unknown'}`,
      ...(result.mismatches || [])
    ],
    videoCodec: result.actual?.videoCodec || 'unknown',
    videoBitrate: videoBitrateK,
    audioCodec: result.actual?.audioCodec || 'unknown',
    audioChannels: Number.isFinite(result.actual?.audioChannels) ? result.actual.audioChannels : 'unknown'
  };
}

export async function executeAudit(input, files = null) {
  const criteria = buildCriteria(input);
  const rootPath = path.resolve(input.root || '.');

  if (Array.isArray(files)) {
    const requestedPaths = Array.from(new Set(
      files
        .map((filePath) => String(filePath || '').trim())
        .filter(Boolean)
    ));

    if (!requestedPaths.length) {
      throw new Error('No files provided for targeted audit.');
    }

    const existingFiles = [];
    const missingFiles = [];

    for (const rawPath of requestedPaths) {
      const resolvedPath = path.resolve(rawPath);
      try {
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          missingFiles.push(resolvedPath);
          continue;
        }
        existingFiles.push({
          path: resolvedPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs
        });
      } catch {
        missingFiles.push(resolvedPath);
      }
    }

    const results = await Promise.all(existingFiles.map((file) => inspectWithFallback(file, criteria)));
    const rows = await Promise.all(results.map((result, idx) => mapAuditResultToRow(result, idx, rootPath)));
    const mismatchedCount = results.filter((item) => !item.matches).length;

    return {
      ok: true,
      summary: {
        rootPath,
        checkedCount: rows.length,
        mismatchedCount,
        requestedCount: requestedPaths.length,
        missingCount: missingFiles.length,
        criteriaText: JSON.stringify(criteria)
      },
      rows,
      missingFiles
    };
  }

  const fullAudit = await runAuditInWorker(input.root, criteria);
  const rows = await Promise.all(fullAudit.results.map((result, idx) => mapAuditResultToRow(result, idx, fullAudit.rootPath)));

  return {
    ok: true,
    summary: {
      rootPath: fullAudit.rootPath,
      checkedCount: fullAudit.results.length,
      mismatchedCount: fullAudit.mismatchedCount,
      criteriaText: JSON.stringify(criteria)
    },
    rows,
    missingFiles: []
  };
}
