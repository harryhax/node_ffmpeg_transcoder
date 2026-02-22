import path from 'node:path';
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { normalizeBitrateToBps, formatBps } from '../src/audit-core.js';

const VALID_OPERATORS = new Set(['>=', '<=', '=']);

function normalizeOperator(value, fallback = '=') {
  return VALID_OPERATORS.has(value) ? value : fallback;
}

function formatRule(label, operator, value) {
  if (value === undefined || value === null || value === '') {
    return `${label}: any`;
  }
  return `${label}: ${operator} ${value}`;
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
    videoCodec: input.videoCodec ? String(input.videoCodec).trim().toLowerCase() : undefined,
    videoBitrate: input.videoBitrate ? normalizeBitrateToBps(input.videoBitrate) : undefined,
    videoBitrateOp,
    videoBitrateTolerancePct: Number.parseFloat(input.videoBitrateTolerancePct ?? '10'),
    audioCodec: input.audioCodec ? String(input.audioCodec).trim().toLowerCase() : undefined,
    audioChannels: input.audioChannels ? Number.parseInt(input.audioChannels, 10) : undefined,
    audioChannelsOp
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

export async function executeAudit(input) {
  const criteria = buildCriteria(input);
  const { rootPath, results, mismatchedCount } = await runAuditInWorker(input.root, criteria);

  const rows = await Promise.all(results.map(async (result, idx) => ({
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
    videoBitrate: Number.isFinite(result.actual?.videoBitrate) ? formatBps(result.actual.videoBitrate) : 'unknown',
    audioCodec: result.actual?.audioCodec || 'unknown',
    audioChannels: Number.isFinite(result.actual?.audioChannels) ? result.actual.audioChannels : 'unknown'
  })));

  return {
    ok: true,
    summary: {
      rootPath,
      checkedCount: results.length,
      mismatchedCount,
      criteriaText: JSON.stringify(criteria)
    },
    rows
  };
}
