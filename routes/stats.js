import express from 'express';
import { getServerStatsHandler } from '../controllers/statsController.js';

const router = express.Router();

router.get('/', getServerStatsHandler);

export default router;
