import express from 'express';
import { getCodecOptionsHandler, getDirectoriesHandler } from '../controllers/optionsController.js';

const router = express.Router();

router.get('/codecs', getCodecOptionsHandler);
router.get('/directories', getDirectoriesHandler);

export default router;
