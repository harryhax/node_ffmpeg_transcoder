import path from 'node:path';
import { buildAuditInput, executeAudit } from '../services/auditService.js';
import { collectVideoFiles } from '../services/auditCore.js';

export async function runAuditHandler(req, res) {
  const input = buildAuditInput(req.body);

  try {
    const payload = await executeAudit(input);
    res.json(payload);
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
}

export async function runAuditFilesHandler(req, res) {
  const input = buildAuditInput(req.body);
  const files = Array.isArray(req.body?.files) ? req.body.files : [];

  try {
    const payload = await executeAudit(input, files);
    res.json(payload);
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
}

export async function listAuditFilesHandler(req, res) {
  const root = String(req.query?.root || '.').trim() || '.';

  try {
    const rootPath = path.resolve(root);
    const files = await collectVideoFiles(rootPath);
    res.json({
      ok: true,
      rootPath,
      count: files.length,
      files: files.map((file) => file.path)
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
}
