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
