import path from 'node:path';
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
    audioCodec: input.audioCodec ? String(input.audioCodec).trim().toLowerCase() : undefined,
    audioChannels: input.audioChannels ? Number.parseInt(input.audioChannels, 10) : undefined,
    audioChannelsOp
  };

  if (input.audioChannels && (!Number.isFinite(criteria.audioChannels) || criteria.audioChannels < 1)) {
    throw new Error('Audio channels must be a positive integer.');
  }

  return criteria;
}

export async function executeAudit(input) {
  const criteria = buildCriteria(input);
  const { rootPath, results, mismatchedCount } = await runAuditInWorker(input.root, criteria);

  const rows = results.map((result, idx) => ({
    fullPath: result.file.path,
    filePath: path.relative(rootPath, result.file.path) || path.basename(result.file.path),
    fileName: path.basename(result.file.path),
    index: idx + 1,
    rawSize: result.file.size, // for MB display and sorting
    size: result.file.size,    // fallback for legacy
    matches: result.matches,
    checks: result.checks || {},
    issues: result.mismatches.length,
    details: result.mismatches || [],
    videoCodec: result.actual?.videoCodec || 'unknown',
    videoBitrate: Number.isFinite(result.actual?.videoBitrate) ? formatBps(result.actual.videoBitrate) : 'unknown',
    audioCodec: result.actual?.audioCodec || 'unknown',
    audioChannels: Number.isFinite(result.actual?.audioChannels) ? result.actual.audioChannels : 'unknown'
  }));

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
