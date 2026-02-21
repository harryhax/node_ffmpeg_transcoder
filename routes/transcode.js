import express from 'express';
import transcodeController from '../controllers/transcodeController.js';

const router = express.Router();
router.post('/', transcodeController.transcode);
router.get('/stream', transcodeController.transcodeStream);

export default router;
