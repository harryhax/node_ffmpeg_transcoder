import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import auditRoutes from './routes/audit.js';
import optionsRoutes from './routes/options.js';
import smokeTestRoutes from './routes/smokeTest.js';
import transcodeRoutes from './routes/transcode.js';
import statsRoutes from './routes/stats.js';

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(publicDir));
app.use('/api', auditRoutes);
app.use('/api/options', optionsRoutes);
app.use('/api', smokeTestRoutes);
app.use('/api/transcode', transcodeRoutes);
app.use('/api/stats', statsRoutes);

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/settings', (_req, res) => {
  res.sendFile(path.join(publicDir, 'settings.html'));
});

app.listen(port, () => {
  console.log(`Web UI running at http://localhost:${port}`);
});
