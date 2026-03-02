import express from 'express';
import { create } from 'express-handlebars';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import auditRoutes from './routes/audit/audit.js';
import optionsRoutes from './routes/options/options.js';
import smokeTestRoutes from './routes/smokeTest.js';
import transcodeRoutes from './routes/transcode/transcode.js';
import statsRoutes from './routes/stats.js';

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const viewsDir = path.join(__dirname, 'views');

const hbs = create({
  extname: '.hbs',
  defaultLayout: 'main',
  layoutsDir: path.join(viewsDir, 'layouts'),
  partialsDir: path.join(viewsDir, 'partials')
});

app.engine('.hbs', hbs.engine);
app.set('view engine', '.hbs');
app.set('views', viewsDir);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(publicDir));
app.use('/api', auditRoutes);
app.use('/api/options', optionsRoutes);
app.use('/api', smokeTestRoutes);
app.use('/api/transcode', transcodeRoutes);
app.use('/api/stats', statsRoutes);

app.get('/', (_req, res) => {
  res.render('index', {
    title: 'HarryHax Transcoder',
    activeAudit: true
  });
});

app.get('/settings', (_req, res) => {
  res.render('settings', {
    title: 'Settings - HarryHax Transcoder',
    activeSettings: true
  });
});

app.get('/about', (_req, res) => {
  res.render('about', {
    title: 'About - HarryHax Transcoder',
    activeAbout: true
  });
});

app.get('/readme', (_req, res) => {
  res.render('readme', {
    title: 'README - HarryHax Transcoder',
    activeReadme: true
  });
});

app.get('/api/readme', async (_req, res) => {
  try {
    const readmePath = path.join(__dirname, 'README.md');
    const content = await fs.readFile(readmePath, 'utf8');
    res.json({ ok: true, content });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Unable to read README.md' });
  }
});

app.listen(port, () => {
  console.log(`Web UI running at http://localhost:${port}`);
});
