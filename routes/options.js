import express from 'express';
import {
	getCodecOptionsHandler,
	getDirectoriesHandler,
	getLogFileHandler,
	getToolPathsHandler,
	setToolPathsHandler,
	getToolHealthHandler
} from '../controllers/optionsController.js';

const router = express.Router();

router.get('/codecs', getCodecOptionsHandler);
router.get('/directories', getDirectoriesHandler);
router.get('/log', getLogFileHandler);
router.get('/tool-paths', getToolPathsHandler);
router.post('/tool-paths', setToolPathsHandler);
router.get('/tool-health', getToolHealthHandler);

export default router;
