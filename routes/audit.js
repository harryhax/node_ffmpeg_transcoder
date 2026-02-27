import express from 'express';
import { listAuditFilesHandler, runAuditFilesHandler, runAuditHandler } from '../controllers/auditController.js';

const router = express.Router();

router.post('/audit', runAuditHandler);
router.get('/audit/files', listAuditFilesHandler);
router.post('/audit/files', runAuditFilesHandler);

export default router;
