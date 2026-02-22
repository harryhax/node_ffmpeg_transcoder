import express from 'express';
import transcodeController from '../controllers/transcodeController.js';

const router = express.Router();
router.get('/summary', transcodeController.transcodeSummary);
router.get('/state', transcodeController.transcodeState);
router.post('/', transcodeController.transcode);
router.get('/stream', transcodeController.transcodeStream);
router.post('/cancel', transcodeController.transcodeCancel);

export default router;
