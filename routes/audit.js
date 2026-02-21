import express from 'express';
import { runAuditHandler } from '../controllers/auditController.js';

const router = express.Router();

router.post('/audit', runAuditHandler);

export default router;
