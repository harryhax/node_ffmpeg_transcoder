import express from 'express';
import { generateSmokeTestHandler } from '../controllers/smokeTestController.js';

const router = express.Router();

router.post('/smoke-test', generateSmokeTestHandler);
// Add legacy/compat endpoint for frontend
router.post('/smoke', generateSmokeTestHandler);

export default router;
