import express from 'express';
import { generateSmokeTestHandler, smokeStreamHandler, smokeCancelHandler } from '../controllers/smokeTestController.js';

const router = express.Router();

router.post('/smoke-test', generateSmokeTestHandler);
// Add legacy/compat endpoint for frontend
router.post('/smoke', generateSmokeTestHandler);
router.get('/smoke/stream', smokeStreamHandler);
router.post('/smoke/cancel', smokeCancelHandler);

export default router;
