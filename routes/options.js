import express from 'express';
import { getCodecOptionsHandler, getDirectoriesHandler, getLogFileHandler } from '../controllers/optionsController.js';

const router = express.Router();

router.get('/codecs', getCodecOptionsHandler);
router.get('/directories', getDirectoriesHandler);
router.get('/log', getLogFileHandler);

export default router;
