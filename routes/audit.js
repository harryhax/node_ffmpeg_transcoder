import express from 'express';
import { runAuditFilesHandler, runAuditHandler } from '../controllers/auditController.js';

const router = express.Router();

router.post('/audit', runAuditHandler);
router.post('/audit/files', runAuditFilesHandler);

export default router;
