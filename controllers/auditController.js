import { buildAuditInput, executeAudit } from '../services/auditService.js';

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
