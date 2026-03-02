import express from 'express';
import { create } from 'express-handlebars';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
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
const require = createRequire(import.meta.url);
const packageJson = require('./package.json');
const APP_VERSION = String(packageJson?.version || '0.0.0');
const VERSION_CACHE_TTL_MS = 30 * 60 * 1000;

let versionStatusCache = {
  expiresAt: 0,
  payload: null
};

function extractGithubRepoSlug(repositoryValue) {
  if (!repositoryValue) {
    return '';
  }

  const repositoryUrl = typeof repositoryValue === 'string'
    ? repositoryValue
    : (typeof repositoryValue?.url === 'string' ? repositoryValue.url : '');
  if (!repositoryUrl) {
    return '';
  }

  const normalized = repositoryUrl
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/i, '');

  const githubHostMatch = normalized.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
  if (githubHostMatch) {
    return `${githubHostMatch[1]}/${githubHostMatch[2]}`;
  }

  const scpLikeMatch = normalized.match(/^git@[^:]+:([^/]+)\/([^/]+)$/i);
  if (scpLikeMatch) {
    return `${scpLikeMatch[1]}/${scpLikeMatch[2]}`;
  }

  return '';
}

function normalizeSemver(version) {
  const raw = String(version || '').trim();
  if (!raw) {
    return [0, 0, 0];
  }
  const cleaned = raw.replace(/^v/i, '').split('-')[0] || '';
  const [major = '0', minor = '0', patch = '0'] = cleaned.split('.');
  return [major, minor, patch].map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function compareSemver(a, b) {
  const aParts = normalizeSemver(a);
  const bParts = normalizeSemver(b);
  for (let index = 0; index < 3; index += 1) {
    if (aParts[index] > bParts[index]) return 1;
    if (aParts[index] < bParts[index]) return -1;
  }
  return 0;
}

async function fetchLatestVersionFromGitHub(repoSlug) {
  const branches = ['main', 'master'];

  for (const branch of branches) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const url = `https://raw.githubusercontent.com/${repoSlug}/${branch}/package.json`;

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'node-ffmpeg-rencode-videos-version-check'
        }
      });
      if (!response.ok) {
        continue;
      }

      const remotePackageJson = await response.json();
      const version = String(remotePackageJson?.version || '').trim();
      if (!version) {
        continue;
      }

      return {
        version,
        branch,
        packageUrl: url
      };
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

const GITHUB_REPO_SLUG = process.env.APP_GITHUB_REPO || extractGithubRepoSlug(packageJson?.repository);

async function getVersionStatus() {
  const now = Date.now();
  if (versionStatusCache.payload && now < versionStatusCache.expiresAt) {
    return versionStatusCache.payload;
  }

  const status = {
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    updateAvailable: false,
    repo: GITHUB_REPO_SLUG,
    githubUrl: GITHUB_REPO_SLUG ? `https://github.com/${GITHUB_REPO_SLUG}` : null,
    checkedAt: new Date().toISOString()
  };

  if (GITHUB_REPO_SLUG) {
    try {
      const latest = await fetchLatestVersionFromGitHub(GITHUB_REPO_SLUG);
      if (latest?.version) {
        status.latestVersion = latest.version;
        status.latestBranch = latest.branch;
        status.latestPackageUrl = latest.packageUrl;
        status.updateAvailable = compareSemver(latest.version, APP_VERSION) > 0;
      }
    } catch (error) {
      status.checkError = error?.message || 'Unable to check GitHub for latest version.';
    }
  }

  versionStatusCache = {
    expiresAt: now + VERSION_CACHE_TTL_MS,
    payload: status
  };

  return status;
}

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
app.use((_req, res, next) => {
  res.locals.appVersion = APP_VERSION;
  next();
});
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

app.get('/api/version', async (_req, res) => {
  try {
    const status = await getVersionStatus();
    res.json({ ok: true, ...status });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Unable to check version status.' });
  }
});

app.listen(port, () => {
  console.log(`Web UI running at http://localhost:${port}`);
});
