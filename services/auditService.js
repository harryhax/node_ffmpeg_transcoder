import path from 'node:path';
import { runAudit, normalizeBitrateToBps, formatBps, formatSize } from '../src/audit-core.js';

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
  const { rootPath, results, mismatchedCount } = await runAudit({
    root: input.root,
    criteria
  });

  const rows = results.map((result, idx) => ({
    fullPath: result.file.path,
    filePath: path.relative(rootPath, result.file.path) || path.basename(result.file.path),
    fileName: path.basename(result.file.path),
    index: idx + 1,
    matches: result.matches,
    checks: result.checks || {},
    size: formatSize(result.file.size),
    videoCodec: result.actual.videoCodec || 'unknown',
    videoBitrate: formatBps(result.actual.videoBitrate),
    audioCodec: result.actual.audioCodec || 'unknown',
    audioChannels: result.actual.audioChannels || 'unknown',
    issues: result.mismatches.length,
    mismatches: result.mismatches
  }));

  return {
    ok: true,
    summary: {
      checkedCount: rows.length,
      mismatchedCount,
      rootPath,
      criteriaText: [
        formatRule('video codec', '=', criteria.videoCodec),
        formatRule('video bitrate', criteria.videoBitrateOp, criteria.videoBitrate ? formatBps(criteria.videoBitrate) : 'any'),
        formatRule('audio codec', '=', criteria.audioCodec),
        formatRule('audio channels', criteria.audioChannelsOp, criteria.audioChannels ?? 'any')
      ].join(' | ')
    },
    rows
  };
}
