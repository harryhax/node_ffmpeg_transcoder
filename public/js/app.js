import { createLogViewerHref } from './utils.js';
import { renderResults, setSelectOptions, getRowState, getStatusLabel } from './ui.js';
import { loadCodecs, loadDirectories, runAudit } from './audit.js';

const CODEC_VISIBILITY_KEY = 'codecVisibilityMode';
const AUDIT_SETTINGS_KEY = 'auditFormSettings';
const LAST_SCAN_RESULTS_KEY = 'lastAuditScanResults';
const OUTPUT_COLLAPSED_KEY = 'activityConsoleCollapsed';
const COMMON_VIDEO_CODECS = ['hevc_videotoolbox', 'hevc', 'h264_videotoolbox', 'h264', 'libx265', 'libx264', 'vp9', 'libvpx-vp9', 'mpeg4', 'av1'];
const COMMON_AUDIO_CODECS = ['ac3', 'aac', 'eac3', 'libopus', 'opus', 'mp3', 'flac', 'dts', 'pcm_s16le', 'vorbis'];

function showCommonCodecsOnly() {
  return globalThis.localStorage?.getItem(CODEC_VISIBILITY_KEY) === 'common';
}

function selectTopCodecs(allCodecs, preferredOrder, limit = 10) {
  const selected = [];
  const available = new Set(allCodecs);

  for (const codec of preferredOrder) {
    if (available.has(codec)) {
      selected.push(codec);
      if (selected.length >= limit) {
        return selected;
      }
    }
  }

  for (const codec of allCodecs) {
    if (!selected.includes(codec)) {
      selected.push(codec);
      if (selected.length >= limit) {
        break;
      }
    }
  }

  return selected;
}

function loadSavedAuditSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(AUDIT_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadCachedScanResults() {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_SCAN_RESULTS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    // Backward-compatible shape: { root, rows, summary }
    if (typeof parsed.root === 'string' && Array.isArray(parsed.rows)) {
      return {
        version: 1,
        byRoot: {
          [parsed.root]: {
            rows: parsed.rows,
            summary: parsed.summary && typeof parsed.summary === 'object' ? parsed.summary : {},
            savedAt: Number.isFinite(parsed.savedAt) ? parsed.savedAt : Date.now()
          }
        },
        lastRoot: parsed.root
      };
    }

    // New shape: { version, byRoot: { [root]: { rows, summary, savedAt } }, lastRoot }
    if (!parsed.byRoot || typeof parsed.byRoot !== 'object') {
      return null;
    }

    const byRoot = {};
    for (const [root, entry] of Object.entries(parsed.byRoot)) {
      if (typeof root !== 'string' || !entry || typeof entry !== 'object') {
        continue;
      }
      if (!Array.isArray(entry.rows)) {
        continue;
      }
      byRoot[root] = {
        rows: entry.rows,
        summary: entry.summary && typeof entry.summary === 'object' ? entry.summary : {},
        savedAt: Number.isFinite(entry.savedAt) ? entry.savedAt : Date.now()
      };
    }

    return {
      version: 1,
      byRoot,
      lastRoot: typeof parsed.lastRoot === 'string' ? parsed.lastRoot : ''
    };
  } catch {
    return null;
  }
}

function saveCachedScanResults(rows, summary = {}) {
  if (!rootInput) {
    return;
  }

  const root = String(rootInput.value || '').trim();
  if (!root) {
    return;
  }

  const existing = loadCachedScanResults() || { version: 1, byRoot: {}, lastRoot: '' };
  const payload = {
    version: 1,
    byRoot: {
      ...existing.byRoot,
      [root]: {
        rows: Array.isArray(rows) ? rows : [],
        summary: summary && typeof summary === 'object' ? summary : {},
        savedAt: Date.now()
      }
    },
    lastRoot: root
  };

  try {
    globalThis.localStorage?.setItem(LAST_SCAN_RESULTS_KEY, JSON.stringify(payload));
  } catch {
  }
}

function restoreCachedScanResultsForCurrentRoot() {
  const cached = loadCachedScanResults();
  if (!cached || !rootInput) {
    return false;
  }

  const currentRoot = String(rootInput.value || '').trim();
  if (!currentRoot) {
    return false;
  }

  const entry = cached.byRoot?.[currentRoot];
  if (!entry || !Array.isArray(entry.rows)) {
    return false;
  }

  const rows = Array.isArray(entry.rows) ? entry.rows : [];
  renderResultsWithStore(rows, resultsBody, () => {});
  updateOriginalTotalFromRows(rows);
  return true;
}

function saveAuditSettings() {
  if (!form) return;
  const data = new FormData(form);
  const existing = loadSavedAuditSettings();
  const transcodeSettingsCollapse = document.getElementById('transcode-settings-collapse');
  const payload = {
    root: data.get('root') || '',
    transcodeLocation: typeof existing.transcodeLocation === 'string' ? existing.transcodeLocation : '',
    scanExtensions: typeof existing.scanExtensions === 'string' ? existing.scanExtensions : '',
    videoCodec: data.get('videoCodec') || '',
    videoBitrateOp: data.get('videoBitrateOp') || '=',
    videoBitrate: data.get('videoBitrate') || '',
    videoBitrateTolerancePct: typeof existing.videoBitrateTolerancePct === 'string' ? existing.videoBitrateTolerancePct : '10',
    audioCodec: data.get('audioCodec') || '',
    audioChannelsOp: data.get('audioChannelsOp') || '=',
    audioChannels: data.get('audioChannels') || '',
    pauseBatteryPct: typeof existing.pauseBatteryPct === 'string' ? existing.pauseBatteryPct : '',
    startBatteryPct: typeof existing.startBatteryPct === 'string' ? existing.startBatteryPct : '',
    saveTranscodeLog: existing.saveTranscodeLog === true,
    capBitrateToSource: existing.capBitrateToSource !== false,
    deleteOriginal: document.getElementById('delete-original')?.checked === true,
    transcodeSettingsExpanded: transcodeSettingsCollapse ? transcodeSettingsCollapse.classList.contains('show') : true
  };
  globalThis.localStorage?.setItem(AUDIT_SETTINGS_KEY, JSON.stringify(payload));
}

function applySavedAuditSettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  if (typeof settings.root === 'string' && settings.root) {
    rootInput.value = settings.root;
  }

  const videoBitrateOpInput = document.getElementById('videoBitrateOp');
  if (videoBitrateOpInput && typeof settings.videoBitrateOp === 'string') {
    videoBitrateOpInput.value = settings.videoBitrateOp;
  }

  const videoBitrateInput = document.getElementById('videoBitrate');
  if (videoBitrateInput && typeof settings.videoBitrate === 'string') {
    videoBitrateInput.value = settings.videoBitrate;
  }

  const pauseBatteryPctInput = document.getElementById('pause-battery-pct');
  if (pauseBatteryPctInput && typeof settings.pauseBatteryPct === 'string') {
    pauseBatteryPctInput.value = settings.pauseBatteryPct;
  }

  const audioChannelsOpInput = document.getElementById('audioChannelsOp');
  if (audioChannelsOpInput && typeof settings.audioChannelsOp === 'string') {
    audioChannelsOpInput.value = settings.audioChannelsOp;
  }

  const audioChannelsInput = document.getElementById('audioChannels');
  if (audioChannelsInput && typeof settings.audioChannels === 'string') {
    audioChannelsInput.value = settings.audioChannels;
  }

  const deleteOriginalInput = document.getElementById('delete-original');
  if (deleteOriginalInput) {
    deleteOriginalInput.checked = settings.deleteOriginal !== false;
  }

  const transcodeSettingsCollapse = document.getElementById('transcode-settings-collapse');
  const transcodeSettingsToggle = document.getElementById('transcode-settings-toggle');
  if (transcodeSettingsCollapse) {
    const isExpanded = settings.transcodeSettingsExpanded !== false;
    transcodeSettingsCollapse.classList.toggle('show', isExpanded);
    if (transcodeSettingsToggle) {
      transcodeSettingsToggle.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      transcodeSettingsToggle.textContent = isExpanded ? 'Collapse' : 'Expand';
    }
  }
}

// DOM elements
const form = document.getElementById('audit-form');
const runButton = document.getElementById('run-btn');
const cancelScanButton = document.getElementById('cancel-scan-btn');
const outputPanelAnchor = document.getElementById('output-panel-anchor');
const resultsBody = document.getElementById('results-body');
const rootInput = document.getElementById('root');
const rootPicker = document.getElementById('root-picker');
const videoCodecSelect = document.getElementById('videoCodec');
const audioCodecSelect = document.getElementById('audioCodec');
const transcodeBtn = document.getElementById('transcode-btn');
const selectAllCheckbox = document.getElementById('select-all-checkbox');
const transcodeSettingsToggle = document.getElementById('transcode-settings-toggle');
const transcodeSettingsCollapse = document.getElementById('transcode-settings-collapse');
const ffmpegWarning = document.getElementById('ffmpeg-warning');
const savedNet = document.getElementById('saved-net');
const savedSource = document.getElementById('saved-source');
const savedFiles = document.getElementById('saved-files');

let transcodeEventSource = null;
let transcodeOutputTimeout = null;
let activeTranscodingFilePath = null;
let latestScanSourceTotalBytes = null;

const transcodeOutputWrap = document.createElement('div');
transcodeOutputWrap.className = 'mt-3';
transcodeOutputWrap.innerHTML = `
  <div class="card border-secondary">
    <div class="card-header py-2 d-flex align-items-center justify-content-between">
      <span>Activity Console</span>
      <div class="d-flex align-items-center gap-2">
        <button id="transcode-output-collapse" class="btn btn-sm btn-outline-secondary" type="button" aria-expanded="true">Collapse</button>
        <button id="transcode-cancel-inline" class="btn btn-sm btn-danger d-none" type="button">Cancel</button>
      </div>
    </div>
    <div class="card-body py-2">
      <div id="transcode-overall-wrap" class="mb-2 d-none">
        <div class="small fw-semibold mb-1">Total Progress</div>
        <div class="progress" role="progressbar" aria-label="Overall transcode progress" aria-valuemin="0" aria-valuemax="100">
          <div id="transcode-overall-bar" class="progress-bar bg-success" style="width: 0%">0%</div>
        </div>
        <div id="transcode-overall-meta" class="small text-muted mt-1">Waiting for queue...</div>
        <div id="transcode-savings-meta" class="small text-muted mt-1 d-none">Space saved: calculating...</div>
      </div>
      <div id="transcode-progress-wrap" class="mb-2 d-none">
        <div class="progress" role="progressbar" aria-label="Transcode progress" aria-valuemin="0" aria-valuemax="100">
          <div id="transcode-progress-bar" class="progress-bar" style="width: 0%">0%</div>
        </div>
        <div id="transcode-progress-meta" class="small text-muted mt-1">Preparing transcode...</div>
      </div>
      <pre id="transcode-output" class="mb-0 d-none" style="height: 240px; overflow: auto; white-space: pre-wrap;"></pre>
    </div>
  </div>
`;
if (outputPanelAnchor) {
  outputPanelAnchor.insertAdjacentElement('afterend', transcodeOutputWrap);
}
const transcodeOutput = transcodeOutputWrap.querySelector('#transcode-output');
const transcodeOutputCollapseButton = transcodeOutputWrap.querySelector('#transcode-output-collapse');
const transcodeOutputTitle = transcodeOutputWrap.querySelector('.card-header span');
const inlineCancelBtn = transcodeOutputWrap.querySelector('#transcode-cancel-inline');
const transcodeOverallWrap = transcodeOutputWrap.querySelector('#transcode-overall-wrap');
const transcodeOverallBar = transcodeOutputWrap.querySelector('#transcode-overall-bar');
const transcodeOverallMeta = transcodeOutputWrap.querySelector('#transcode-overall-meta');
const transcodeSavingsMeta = transcodeOutputWrap.querySelector('#transcode-savings-meta');
const transcodeProgressWrap = transcodeOutputWrap.querySelector('#transcode-progress-wrap');
const transcodeProgressBar = transcodeOutputWrap.querySelector('#transcode-progress-bar');
const transcodeProgressMeta = transcodeOutputWrap.querySelector('#transcode-progress-meta');
let transcodeOutputMessages = [];
let transcodeOutputCollapsed = true;
const TRANSODE_OUTPUT_EXPANDED_HEIGHT_PX = 240;
const TRANSODE_OUTPUT_COLLAPSED_HEIGHT_PX = 56;

function readOutputCollapsedPreference() {
  try {
    const raw = globalThis.localStorage?.getItem(OUTPUT_COLLAPSED_KEY);
    if (raw === null) {
      return true;
    }
    return raw === 'true';
  } catch {
    return true;
  }
}

function saveOutputCollapsedPreference(isCollapsed) {
  try {
    globalThis.localStorage?.setItem(OUTPUT_COLLAPSED_KEY, isCollapsed ? 'true' : 'false');
  } catch {
  }
}

function escapeConsoleHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function classifyConsoleLine(lineText) {
  const text = String(lineText || '').toLowerCase();
  if (text.includes('[error]') || text.includes('[danger]') || text.includes('[failed]') || text.includes(' failed')) {
    return 'console-line-error';
  }
  if (text.includes('[warning]') || text.includes('[warn]') || text.includes(' warning')) {
    return 'console-line-warning';
  }
  if (text.includes('[success]') || text.includes('[done]') || text.includes(' completed') || text.includes(' complete')) {
    return 'console-line-success';
  }
  return 'console-line-default';
}

function renderExpandedConsoleMarkup(text) {
  const lines = String(text || '').split('\n');
  return lines
    .map((line, idx) => {
      const className = classifyConsoleLine(line);
      const suffix = idx < lines.length - 1 ? '\n' : '';
      return `<span class="${className}">${escapeConsoleHtml(line)}${suffix}</span>`;
    })
    .join('');
}

function renderTranscodeOutput() {
  if (!transcodeOutput) {
    return;
  }

  if (transcodeOutputCollapsed) {
    const lastMessage = transcodeOutputMessages.length > 0
      ? String(transcodeOutputMessages[transcodeOutputMessages.length - 1] || '').trimEnd()
      : '';
    transcodeOutput.textContent = lastMessage;
    transcodeOutput.style.height = `${TRANSODE_OUTPUT_COLLAPSED_HEIGHT_PX}px`;
    transcodeOutput.style.overflow = 'auto';
  } else {
    const fullText = transcodeOutputMessages.join('');
    transcodeOutput.innerHTML = renderExpandedConsoleMarkup(fullText);
    transcodeOutput.style.height = `${TRANSODE_OUTPUT_EXPANDED_HEIGHT_PX}px`;
    transcodeOutput.style.overflow = 'auto';
  }

  transcodeOutput.classList.remove('d-none');
  transcodeOutput.scrollTop = transcodeOutput.scrollHeight;
}

function setTranscodeOutputCollapsed(isCollapsed, { persist = true } = {}) {
  transcodeOutputCollapsed = isCollapsed === true;
  if (persist) {
    saveOutputCollapsedPreference(transcodeOutputCollapsed);
  }
  if (transcodeOutputCollapseButton) {
    transcodeOutputCollapseButton.textContent = transcodeOutputCollapsed ? 'Expand' : 'Collapse';
    transcodeOutputCollapseButton.setAttribute('aria-expanded', transcodeOutputCollapsed ? 'false' : 'true');
  }
  renderTranscodeOutput();
}

function clearTranscodeOutput() {
  transcodeOutputMessages = [];
  renderTranscodeOutput();
}

function isAnyJobRunning() {
  const scanRunning = runButton?.disabled === true;
  const transcodeRunning = transcodeBtn?.disabled === true;
  return scanRunning || transcodeRunning;
}

function setIdleOutputPanelState() {
  if (transcodeOutputTitle) {
    transcodeOutputTitle.textContent = 'Activity Console';
  }
  if (inlineCancelBtn) {
    inlineCancelBtn.classList.add('d-none');
    inlineCancelBtn.disabled = false;
  }
  if (transcodeProgressWrap) {
    transcodeProgressWrap.classList.add('d-none');
  }
  if (transcodeOverallWrap) {
    transcodeOverallWrap.classList.add('d-none');
  }
  if (transcodeSavingsMeta) {
    transcodeSavingsMeta.classList.add('d-none');
  }
}

if (transcodeOutputCollapseButton) {
  transcodeOutputCollapseButton.addEventListener('click', () => {
    setTranscodeOutputCollapsed(!transcodeOutputCollapsed);
  });
}
setTranscodeOutputCollapsed(readOutputCollapsedPreference(), { persist: false });
setIdleOutputPanelState();

function formatDurationClock(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '--:--';
  }
  const rounded = Math.floor(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function updateTranscodeProgress(progressPayload) {
  if (!transcodeProgressWrap || !transcodeProgressBar || !transcodeProgressMeta) {
    return;
  }

  transcodeProgressWrap.classList.remove('d-none');
  const safePercent = Number.isFinite(progressPayload?.percent)
    ? Math.max(0, Math.min(100, progressPayload.percent))
    : 0;
  const percentText = `${Math.round(safePercent)}%`;
  transcodeProgressBar.style.width = `${safePercent}%`;
  transcodeProgressBar.textContent = percentText;
  transcodeProgressBar.setAttribute('aria-valuenow', String(Math.round(safePercent)));

  const filePath = typeof progressPayload?.file === 'string' ? progressPayload.file : '';
  const fileName = filePath ? filePath.split(/[\\/]/).pop() : 'Current file';
  const currentText = formatDurationClock(progressPayload?.processedSeconds);
  const totalText = formatDurationClock(progressPayload?.totalDurationSeconds);
  const etaText = Number.isFinite(progressPayload?.etaSeconds) ? formatDurationClock(progressPayload.etaSeconds) : '--:--';
  const speedText = Number.isFinite(progressPayload?.speed) ? `${progressPayload.speed.toFixed(2)}x` : '--';

  transcodeProgressMeta.textContent = `${fileName} • ${currentText} / ${totalText} • ETA ${etaText} • Speed ${speedText}`;
}

function updateTranscodeOverallProgress(overallPayload) {
  if (!transcodeOverallWrap || !transcodeOverallBar || !transcodeOverallMeta) {
    return;
  }

  transcodeOverallWrap.classList.remove('d-none');
  const safePercent = Number.isFinite(overallPayload?.percent)
    ? Math.max(0, Math.min(100, overallPayload.percent))
    : 0;
  const percentText = `${Math.round(safePercent)}%`;
  transcodeOverallBar.style.width = `${safePercent}%`;
  transcodeOverallBar.textContent = percentText;
  transcodeOverallBar.setAttribute('aria-valuenow', String(Math.round(safePercent)));

  const completedFiles = Number.isFinite(overallPayload?.completedFiles) ? overallPayload.completedFiles : 0;
  const totalFiles = Number.isFinite(overallPayload?.totalFiles) ? overallPayload.totalFiles : 0;
  const etaText = Number.isFinite(overallPayload?.etaSeconds) ? formatDurationClock(overallPayload.etaSeconds) : '--:--';
  const speedText = Number.isFinite(overallPayload?.averageSpeed) ? `${overallPayload.averageSpeed.toFixed(2)}x` : '--';
  const confidenceRaw = typeof overallPayload?.estimateConfidence === 'string'
    ? overallPayload.estimateConfidence.toLowerCase()
    : 'low';
  const confidenceLabel = confidenceRaw === 'high'
    ? 'Estimate: high confidence'
    : (confidenceRaw === 'medium' ? 'Estimate: medium confidence' : 'Estimate: low confidence');
  transcodeOverallMeta.textContent = `${completedFiles}/${totalFiles} files • ETA ${etaText} • Average speed ${speedText} • ${confidenceLabel}`;
}

function appendTranscodeOutput(text) {
  if (!transcodeOutput) {
    return;
  }
  transcodeOutputMessages.push(String(text || ''));
  const maxChars = 18000;
  let totalChars = transcodeOutputMessages.reduce((sum, message) => sum + message.length, 0);
  while (totalChars > maxChars && transcodeOutputMessages.length > 1) {
    const removed = transcodeOutputMessages.shift();
    totalChars -= removed ? removed.length : 0;
  }
  renderTranscodeOutput();
}

function writeUiMessage(level, text, logPath = null) {
  const normalizedLevel = String(level || 'info').toUpperCase();
  const safeText = String(text || '').trim();
  if (!safeText) {
    return;
  }

  transcodeOutputWrap.classList.remove('d-none');
  if (!isAnyJobRunning()) {
    setIdleOutputPanelState();
  }

  appendTranscodeOutput(`[${normalizedLevel}] ${safeText}\n`);
  if (logPath) {
    const href = createLogViewerHref(logPath);
    if (href) {
      appendTranscodeOutput(`[LOG] ${href}\n`);
    }
  }
}

function formatMB(bytes) {
  if (!Number.isFinite(bytes)) {
    return '--';
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function refreshToolHealthWarning() {
  if (!ffmpegWarning) {
    return;
  }

  const buildMissingToolsErrorHtml = (missingTools) => {
    const normalized = Array.isArray(missingTools)
      ? missingTools
        .map((tool) => String(tool || '').trim().toLowerCase())
        .filter(Boolean)
      : [];

    const uniqueMissing = [...new Set(normalized)];
    const missingText = uniqueMissing.length === 1
      ? `<strong>${uniqueMissing[0]}</strong>`
      : uniqueMissing.length > 1
        ? `<strong>${uniqueMissing.join('</strong> and <strong>')}</strong>`
        : '<strong>FFMPEG</strong> and <strong>FFPROBE</strong>';

    return `⛔ <strong>Critical Error:</strong> Missing required tool(s): ${missingText}. Install from <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener noreferrer">https://ffmpeg.org/download.html</a>, or use <strong>Settings</strong> to point directly to your ffmpeg/ffprobe folders if already installed.`;
  };

  try {
    const response = await fetch('/api/options/tool-health');
    const data = await response.json();
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || 'Unable to check ffmpeg/ffprobe health.');
    }

    const health = data.health || {};
    const ffmpegOk = health?.ffmpeg?.ok === true;
    const ffprobeOk = health?.ffprobe?.ok === true;
    if (ffmpegOk && ffprobeOk) {
      ffmpegWarning.classList.add('d-none');
      ffmpegWarning.innerHTML = '';
      return;
    }

    ffmpegWarning.classList.remove('d-none');
    const missingTools = [];
    if (!ffmpegOk) {
      missingTools.push('ffmpeg');
    }
    if (!ffprobeOk) {
      missingTools.push('ffprobe');
    }
    ffmpegWarning.innerHTML = buildMissingToolsErrorHtml(missingTools);
  } catch (error) {
    ffmpegWarning.classList.remove('d-none');
    ffmpegWarning.innerHTML = buildMissingToolsErrorHtml(['ffmpeg', 'ffprobe']);
  }
}

function isToolAvailabilityError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('failed to start')
    || text.includes('ffmpeg')
    || text.includes('ffprobe');
}

function getRowsTotalBytes(rows) {
  if (!Array.isArray(rows)) {
    return 0;
  }

  return rows.reduce((sum, row) => {
    const rowBytes = Number.isFinite(row?.sourceStats?.sizeBytes)
      ? row.sourceStats.sizeBytes
      : (Number.isFinite(row?.rawSize) ? row.rawSize : 0);
    return sum + rowBytes;
  }, 0);
}

function updateOriginalTotalFromRows(rows) {
  if (!savedSource) {
    return;
  }

  const totalBytes = getRowsTotalBytes(rows);
  latestScanSourceTotalBytes = totalBytes;

  savedSource.textContent = formatMB(totalBytes);
}

function updateNetSavedFromRows(rows) {
  if (!savedNet || !Number.isFinite(latestScanSourceTotalBytes)) {
    return;
  }

  const currentTotalBytes = getRowsTotalBytes(rows);
  const netSavedBytes = latestScanSourceTotalBytes - currentTotalBytes;
  if (netSavedBytes >= 0) {
    savedNet.textContent = formatMB(netSavedBytes);
  } else {
    savedNet.textContent = `-${formatMB(Math.abs(netSavedBytes))}`;
  }
}

function renderAppSavingsSummary(summary) {
  if (!savedNet || !savedSource || !savedFiles) {
    return;
  }

  const sourceBytes = Number.isFinite(summary?.sourceBytes) ? summary.sourceBytes : 0;
  const outputBytes = Number.isFinite(summary?.outputBytes) ? summary.outputBytes : 0;
  const savedBytes = Number.isFinite(summary?.savedBytes) ? summary.savedBytes : (sourceBytes - outputBytes);
  const filesCount = Number.isFinite(summary?.filesTranscoded) ? summary.filesTranscoded : 0;

  if (!Number.isFinite(latestScanSourceTotalBytes)) {
    if (savedBytes >= 0) {
      savedNet.textContent = formatMB(savedBytes);
    } else {
      savedNet.textContent = `-${formatMB(Math.abs(savedBytes))}`;
    }
    savedSource.textContent = formatMB(sourceBytes);
  }
  savedFiles.textContent = String(filesCount);
}

async function refreshAppSavingsSummary() {
  if (!savedNet || !savedSource || !savedFiles) {
    return;
  }

  try {
    const response = await fetch('/api/transcode/summary');
    const data = await response.json();
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || 'Unable to load transcode summary.');
    }
    renderAppSavingsSummary(data.summary || {});
  } catch {
  }
}

function updateTranscodeSavingsSummary(results) {
  if (!transcodeSavingsMeta) {
    return;
  }

  const successful = Array.isArray(results)
    ? results.filter((item) => item?.ok === true && Number.isFinite(item?.sourceSizeBytes) && Number.isFinite(item?.outputSizeBytes))
    : [];

  if (!successful.length) {
    transcodeSavingsMeta.classList.remove('d-none');
    transcodeSavingsMeta.textContent = 'Space saved: unavailable.';
    return;
  }

  const totalSourceBytes = successful.reduce((sum, item) => sum + item.sourceSizeBytes, 0);
  const totalOutputBytes = successful.reduce((sum, item) => sum + item.outputSizeBytes, 0);
  const totalSavedBytes = totalSourceBytes - totalOutputBytes;
  const savedPct = totalSourceBytes > 0 ? ((totalSavedBytes / totalSourceBytes) * 100) : 0;

  transcodeSavingsMeta.classList.remove('d-none');
  if (totalSavedBytes >= 0) {
    transcodeSavingsMeta.textContent = `Space saved: ${formatMB(totalSavedBytes)} (${savedPct.toFixed(1)}%) across ${successful.length} file(s).`;
  } else {
    transcodeSavingsMeta.textContent = `Space change: +${formatMB(Math.abs(totalSavedBytes))} (${Math.abs(savedPct).toFixed(1)}% larger) across ${successful.length} file(s).`;
  }
}

function getRowPath(row) {
  return String(row?.fullPath || row?.filePath || '');
}

async function refreshRowsAfterTranscode(transcodeResults) {
  if (!Array.isArray(window._lastAuditRows) || !Array.isArray(transcodeResults) || !transcodeResults.length) {
    return;
  }

  const touched = new Set();
  for (const item of transcodeResults) {
    if (typeof item?.file === 'string' && item.file.trim()) {
      touched.add(item.file.trim());
    }
    if (typeof item?.output === 'string' && item.output.trim()) {
      touched.add(item.output.trim());
    }
  }

  if (!touched.size) {
    return;
  }

  const formData = new FormData(form);
  const saved = loadSavedAuditSettings();
  const response = await fetch('/api/audit/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      root: rootInput?.value || '.',
      videoCodec: formData.get('videoCodec') || '',
      videoBitrateOp: formData.get('videoBitrateOp') || '=',
      videoBitrate: formData.get('videoBitrate') ? `${formData.get('videoBitrate')}k` : '',
      videoBitrateTolerancePct: typeof saved.videoBitrateTolerancePct === 'string' ? saved.videoBitrateTolerancePct : '10',
      audioCodec: formData.get('audioCodec') || '',
      audioChannelsOp: formData.get('audioChannelsOp') || '>=',
      audioChannels: formData.get('audioChannels') || '',
      files: Array.from(touched)
    })
  });

  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || 'Failed to refresh changed rows.');
  }

  const refreshedRows = Array.isArray(payload.rows) ? payload.rows : [];
  const missingFiles = Array.isArray(payload.missingFiles) ? payload.missingFiles : [];

  let mergedRows = Array.isArray(window._lastAuditRows) ? [...window._lastAuditRows] : [];
  if (missingFiles.length) {
    const missingSet = new Set(missingFiles.map((filePath) => String(filePath)));
    mergedRows = mergedRows.filter((row) => !missingSet.has(getRowPath(row)));
  }

  const refreshedByPath = new Map(refreshedRows.map((row) => [getRowPath(row), row]));
  mergedRows = mergedRows.map((row) => {
    const replacement = refreshedByPath.get(getRowPath(row));
    return replacement ? { ...row, ...replacement } : row;
  });

  const existingPaths = new Set(mergedRows.map((row) => getRowPath(row)));
  for (const refreshed of refreshedRows) {
    const refreshedPath = getRowPath(refreshed);
    if (!existingPaths.has(refreshedPath)) {
      mergedRows.push(refreshed);
      existingPaths.add(refreshedPath);
    }
  }

  const resultBySource = new Map();
  const resultByOutput = new Map();
  for (const item of transcodeResults) {
    if (typeof item?.file === 'string' && item.file.trim()) {
      resultBySource.set(item.file.trim(), item);
    }
    if (typeof item?.output === 'string' && item.output.trim()) {
      resultByOutput.set(item.output.trim(), item);
    }
  }

  mergedRows = mergedRows.map((row) => {
    const rowPath = getRowPath(row);
    const transcodeResult = resultBySource.get(rowPath) || resultByOutput.get(rowPath);
    if (!transcodeResult) {
      return row;
    }
    return {
      ...row,
      transcodeOutput: transcodeResult.output || row.transcodeOutput,
      logPath: transcodeResult.logPath || row.logPath
    };
  });

  mergedRows.sort((a, b) => {
    const aSize = Number.isFinite(a?.rawSize) ? a.rawSize : 0;
    const bSize = Number.isFinite(b?.rawSize) ? b.rawSize : 0;
    return bSize - aSize;
  });
  mergedRows = mergedRows.map((row, index) => ({ ...row, index: index + 1 }));

  renderResultsWithStore(mergedRows, resultsBody, () => {});
}

function showTranscodeOutput() {
  if (transcodeOutputTimeout) {
    clearTimeout(transcodeOutputTimeout);
    transcodeOutputTimeout = null;
  }
  if (transcodeOutputTitle) {
    transcodeOutputTitle.textContent = 'Transcode Progress';
  }
  clearTranscodeOutput();
  if (transcodeOverallWrap) {
    transcodeOverallWrap.classList.remove('d-none');
  }
  if (transcodeOverallBar) {
    transcodeOverallBar.style.width = '0%';
    transcodeOverallBar.textContent = '0%';
    transcodeOverallBar.setAttribute('aria-valuenow', '0');
  }
  if (transcodeOverallMeta) {
    transcodeOverallMeta.textContent = 'Preparing queue estimate...';
  }
  if (transcodeSavingsMeta) {
    transcodeSavingsMeta.classList.remove('d-none');
    transcodeSavingsMeta.textContent = 'Space saved: calculating...';
  }
  if (transcodeProgressWrap) {
    transcodeProgressWrap.classList.remove('d-none');
  }
  if (transcodeProgressBar) {
    transcodeProgressBar.style.width = '0%';
    transcodeProgressBar.textContent = '0%';
    transcodeProgressBar.setAttribute('aria-valuenow', '0');
  }
  if (transcodeProgressMeta) {
    transcodeProgressMeta.textContent = 'Preparing transcode...';
  }
  if (inlineCancelBtn) {
    inlineCancelBtn.classList.remove('d-none');
    inlineCancelBtn.disabled = false;
  }
}

function showScanOutput() {
  if (transcodeOutputTimeout) {
    clearTimeout(transcodeOutputTimeout);
    transcodeOutputTimeout = null;
  }
  if (transcodeOutputTitle) {
    transcodeOutputTitle.textContent = 'Scan Output';
  }
  clearTranscodeOutput();
  if (transcodeOverallWrap) {
    transcodeOverallWrap.classList.add('d-none');
  }
  if (transcodeProgressWrap) {
    transcodeProgressWrap.classList.add('d-none');
  }
  if (transcodeSavingsMeta) {
    transcodeSavingsMeta.classList.add('d-none');
  }
  if (inlineCancelBtn) {
    inlineCancelBtn.classList.add('d-none');
    inlineCancelBtn.disabled = false;
  }
}

function hideScanOutputLater() {
  hideTranscodeOutputLater();
}

function hideTranscodeOutputLater() {
  transcodeOutputTimeout = setTimeout(() => {
    if (inlineCancelBtn) {
      inlineCancelBtn.classList.add('d-none');
      inlineCancelBtn.disabled = false;
    }
    setIdleOutputPanelState();
    if (transcodeProgressWrap) {
      transcodeProgressWrap.classList.add('d-none');
    }
    if (transcodeOverallWrap) {
      transcodeOverallWrap.classList.add('d-none');
    }
    if (transcodeSavingsMeta) {
      transcodeSavingsMeta.classList.add('d-none');
      transcodeSavingsMeta.textContent = 'Space saved: calculating...';
    }
    transcodeOutputTimeout = null;
  }, 1200);
}

function closeTranscodeEventStream() {
  if (transcodeEventSource) {
    transcodeEventSource.close();
    transcodeEventSource = null;
  }
}

function findResultRowByPath(filePath) {
  if (!filePath) {
    return null;
  }
  const rows = Array.from(document.querySelectorAll('#results-body tr[data-file-path]'));
  return rows.find((row) => row.getAttribute('data-file-path') === filePath) || null;
}

function clearActiveTranscodingRowHighlight() {
  const rows = document.querySelectorAll('#results-body tr.transcode-active-row');
  rows.forEach((row) => row.classList.remove('transcode-active-row'));
}

function setActiveTranscodingRow(filePath) {
  activeTranscodingFilePath = filePath || null;
  clearActiveTranscodingRowHighlight();
  if (!activeTranscodingFilePath) {
    return;
  }
  const row = findResultRowByPath(activeTranscodingFilePath);
  if (row) {
    row.classList.add('transcode-active-row');
  }
}

function clearTranscodeOutcomeHighlights() {
  const rows = document.querySelectorAll('#results-body tr.transcode-result-match, #results-body tr.transcode-result-mismatch');
  rows.forEach((row) => {
    row.classList.remove('transcode-result-match');
    row.classList.remove('transcode-result-mismatch');
  });
}

function flashTranscodeOutcomeForPath(filePath) {
  if (!filePath) {
    return;
  }

  const targetRow = findResultRowByPath(filePath);
  if (!targetRow) {
    return;
  }

  const rowData = Array.isArray(window._lastAuditRows)
    ? window._lastAuditRows.find((row) => getRowPath(row) === filePath)
    : null;
  if (!rowData) {
    return;
  }

  const isMatch = rowData.matches === true;
  clearTranscodeOutcomeHighlights();
  targetRow.classList.add(isMatch ? 'transcode-result-match' : 'transcode-result-mismatch');

  setTimeout(() => {
    targetRow.classList.remove('transcode-result-match');
    targetRow.classList.remove('transcode-result-mismatch');
  }, 2500);
}

function isPowerManagementCondition(text) {
  const value = String(text || '').toLowerCase();
  return value.includes('battery')
    || value.includes('threshold')
    || value.includes('paused:')
    || value.includes('resumed:')
    || value.includes('cannot verify battery');
}

function notifyTranscodeCondition(text) {
  if (!text || !isPowerManagementCondition(text)) {
    return;
  }
  const level = String(text).toLowerCase().includes('resumed:') ? 'info' : 'warning';
  writeUiMessage(level, text);
}

function renderMessageWithLogLink(type, text, logPath) {
  writeUiMessage(type, text, logPath);
}

function startTranscodeEventStream() {
  closeTranscodeEventStream();
  transcodeEventSource = new EventSource('/api/transcode/stream');

  transcodeEventSource.addEventListener('status', (event) => {
    if (typeof event.data === 'string' && event.data.toLowerCase().includes('transcode in progress')) {
      if (transcodeBtn) {
        transcodeBtn.disabled = true;
      }
      transcodeOutputWrap.classList.remove('d-none');
    }
    appendTranscodeOutput(`[status] ${event.data}\n`);
    notifyTranscodeCondition(event.data);
  });

  transcodeEventSource.addEventListener('file-start', (event) => {
    try {
      const payload = JSON.parse(event.data);
      const file = typeof payload?.file === 'string' ? payload.file : null;
      if (file) {
        setActiveTranscodingRow(file);
      }
    } catch {
    }
  });

  transcodeEventSource.addEventListener('file-complete', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.file && activeTranscodingFilePath === payload.file) {
        setActiveTranscodingRow(null);
      }
      refreshRowsAfterTranscode([payload])
        .then(() => {
          const preferredPath = typeof payload?.output === 'string' && payload.output.trim()
            ? payload.output.trim()
            : (typeof payload?.file === 'string' ? payload.file.trim() : '');
          flashTranscodeOutcomeForPath(preferredPath);
        })
        .catch((error) => {
          appendTranscodeOutput(`[status] Live table update failed: ${error.message}\n`);
        });
    } catch {
    }
  });

  transcodeEventSource.addEventListener('file-failed', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.file && activeTranscodingFilePath === payload.file) {
        setActiveTranscodingRow(null);
      }
    } catch {
    }
  });

  transcodeEventSource.addEventListener('log', (event) => {
    appendTranscodeOutput(`${event.data}\n`);
  });

  transcodeEventSource.addEventListener('progress', (event) => {
    try {
      const payload = JSON.parse(event.data);
      updateTranscodeProgress(payload);
    } catch {
    }
  });

  transcodeEventSource.addEventListener('overall', (event) => {
    try {
      const payload = JSON.parse(event.data);
      updateTranscodeOverallProgress(payload);
    } catch {
    }
  });

  transcodeEventSource.addEventListener('done', (event) => {
    appendTranscodeOutput(`[done] ${event.data}\n`);
    setActiveTranscodingRow(null);
    if (transcodeBtn) {
      transcodeBtn.disabled = false;
    }
    closeTranscodeEventStream();
    hideTranscodeOutputLater();
  });

  transcodeEventSource.addEventListener('error', () => {
    setActiveTranscodingRow(null);
    if (transcodeBtn) {
      transcodeBtn.disabled = false;
    }
    closeTranscodeEventStream();
    hideTranscodeOutputLater();
  });
}

async function recoverTranscodeSessionIfRunning() {
  try {
    const response = await fetch('/api/transcode/state');
    const data = await response.json();
    if (!response.ok || !data?.ok) {
      return;
    }

    const state = data.state || {};
    if (state.inProgress !== true) {
      return;
    }

    showTranscodeOutput();
    if (transcodeBtn) {
      transcodeBtn.disabled = true;
    }
    if (state.overall) {
      updateTranscodeOverallProgress(state.overall);
    }
    if (state.progress) {
      updateTranscodeProgress(state.progress);
    }
    if (state.activeFile && typeof state.activeFile.file === 'string') {
      setActiveTranscodingRow(state.activeFile.file);
    }

    writeUiMessage('info', 'Resumed view of running transcode job.');
    startTranscodeEventStream();
  } catch {
  }
}


if (inlineCancelBtn) {
  inlineCancelBtn.addEventListener('click', async () => {
    inlineCancelBtn.disabled = true;
    writeUiMessage('info', 'Cancelling transcode...');
    try {
      const res = await fetch('/api/transcode/cancel', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Cancel failed.');
      writeUiMessage('success', data.message || 'Transcode cancelled.');
    } catch (err) {
      writeUiMessage('danger', err.message);
    } finally {
      inlineCancelBtn.disabled = false;
    }
  });
}

// Helper to sync codec dropdowns
async function syncCodecDropdowns() {
  const savedSettings = loadSavedAuditSettings();
  const response = await fetch('/api/options/codecs');
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load codec options.');
  const filteredVideoCodecs = showCommonCodecsOnly()
    ? selectTopCodecs(data.videoCodecs, COMMON_VIDEO_CODECS, 10)
    : data.videoCodecs;
  const filteredAudioCodecs = showCommonCodecsOnly()
    ? selectTopCodecs(data.audioCodecs, COMMON_AUDIO_CODECS, 10)
    : data.audioCodecs;
  // Map for display: hevc (CPU) and hevc (GPU)
  const videoCodecOptions = filteredVideoCodecs.map(c => {
    if (c === 'hevc') return { value: 'hevc', label: 'hevc (CPU)' };
    if (c === 'hevc_videotoolbox') return { value: 'hevc_videotoolbox', label: 'hevc (GPU)' };
    return { value: c, label: c };
  });
  // Prefer GPU codecs by default
  const gpuPreferred = ['hevc_videotoolbox', 'h264_videotoolbox', 'cuda', 'nvenc', 'qsv', 'vaapi'];
  let defaultVideo = savedSettings.videoCodec || videoCodecOptions.find(c => gpuPreferred.includes(c.value))?.value || videoCodecOptions[0]?.value || '';
  setSelectOptions(videoCodecSelect, videoCodecOptions, defaultVideo);
  setSelectOptions(audioCodecSelect, filteredAudioCodecs, savedSettings.audioCodec || 'aac');
}

// Initial load
(async () => {
  try {
    await refreshToolHealthWarning();
    const savedSettings = loadSavedAuditSettings();
    applySavedAuditSettings(savedSettings);
    if (rootInput && (!rootInput.value || !String(rootInput.value).trim())) {
      rootInput.value = './smoke-fixtures';
    }
    await syncCodecDropdowns();
    if (rootInput && rootPicker) {
      await loadDirectories(rootInput, rootPicker);
      if (savedSettings.root) {
        rootPicker.value = savedSettings.root;
      }
    }
    const restored = restoreCachedScanResultsForCurrentRoot();
    if (restored) {
      writeUiMessage('info', `Restored saved scan results for ${rootInput?.value || './smoke-fixtures'}.`);
    } else {
      writeUiMessage('info', `Scan files using root folder: ${rootInput?.value || './smoke-fixtures'}.`);
    }
    await recoverTranscodeSessionIfRunning();
  } catch (error) {
    await refreshToolHealthWarning();
    if (!isToolAvailabilityError(error)) {
      writeUiMessage('danger', error.message);
    }
  }
})();

refreshAppSavingsSummary();
setInterval(refreshAppSavingsSummary, 5000);

form.addEventListener('change', saveAuditSettings);
form.addEventListener('input', saveAuditSettings);

if (rootPicker) {
  rootPicker.addEventListener('change', async () => {
    if (rootInput && rootPicker.value) {
      rootInput.value = rootPicker.value;
      saveAuditSettings();
      try {
        await loadDirectories(rootInput, rootPicker);
      } catch {
      }
      const restored = restoreCachedScanResultsForCurrentRoot();
      if (restored) {
        writeUiMessage('info', `Restored saved scan results for ${rootInput.value}.`);
      } else {
        writeUiMessage('info', `No saved scan results found for ${rootInput.value}.`);
      }
    }
  });
}

if (rootInput) {
  rootInput.addEventListener('change', () => {
    saveAuditSettings();
    const restored = restoreCachedScanResultsForCurrentRoot();
    if (restored) {
      writeUiMessage('info', `Restored saved scan results for ${rootInput.value}.`);
    }
  });
}

if (transcodeSettingsCollapse) {
  transcodeSettingsCollapse.addEventListener('shown.bs.collapse', () => {
    if (transcodeSettingsToggle) {
      transcodeSettingsToggle.textContent = 'Collapse';
      transcodeSettingsToggle.setAttribute('aria-expanded', 'true');
    }
    saveAuditSettings();
  });
  transcodeSettingsCollapse.addEventListener('hidden.bs.collapse', () => {
    if (transcodeSettingsToggle) {
      transcodeSettingsToggle.textContent = 'Expand';
      transcodeSettingsToggle.setAttribute('aria-expanded', 'false');
    }
    saveAuditSettings();
  });
}

// Patch renderResults to store last audit rows for transcode lookup
import { renderResults as origRenderResults } from './ui.js';
window._lastAuditRows = [];
function setupEnhancements(rows) {
  // Bootstrap tooltips
  if (globalThis.bootstrap) {
    // Dispose existing tooltips first
    const tooltipNodes = resultsBody.querySelectorAll('[data-bs-toggle="tooltip"]');
    tooltipNodes.forEach(node => {
      if (node._tooltipInstance) {
        node._tooltipInstance.dispose();
      }
      node._tooltipInstance = new globalThis.bootstrap.Tooltip(node);
    });
  }
  // Tablesort
  if (globalThis.Tablesort) {
    new globalThis.Tablesort(document.getElementById('results-table'));
  }
  // Select-all checkbox logic
  function updateSelectAllCheckbox() {
    const checkboxes = document.querySelectorAll('.row-checkbox');
    const checked = Array.from(checkboxes).filter(cb => cb.checked);
    selectAllCheckbox.checked = checkboxes.length > 0 && checked.length === checkboxes.length;
    selectAllCheckbox.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
  }
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', () => {
      const checkboxes = document.querySelectorAll('.row-checkbox');
      for (const cb of checkboxes) {
        cb.checked = selectAllCheckbox.checked;
      }
    });
  }
  // Update select-all state after rendering results
  updateSelectAllCheckbox();
  const checkboxes = document.querySelectorAll('.row-checkbox');
  for (const cb of checkboxes) {
    cb.addEventListener('change', updateSelectAllCheckbox);
  }
}

function renderResultsWithStore(rows, ...args) {
  window._lastAuditRows = rows;
  origRenderResults(rows, resultsBody, setupEnhancements);
  updateNetSavedFromRows(rows);
  saveCachedScanResults(rows);
  if (activeTranscodingFilePath) {
    setActiveTranscodingRow(activeTranscodingFilePath);
  }
}

function confirmDeleteOriginalWarning() {
  return new Promise((resolve) => {
    const modalElement = document.getElementById('deleteOriginalWarningModal');
    const confirmButton = document.getElementById('confirm-delete-original-btn');

    if (!modalElement || !confirmButton || !globalThis.bootstrap) {
      resolve(false);
      return;
    }

    const modal = new globalThis.bootstrap.Modal(modalElement);
    let resolved = false;

    const cleanup = () => {
      confirmButton.removeEventListener('click', onConfirm);
      modalElement.removeEventListener('hidden.bs.modal', onHidden);
    };

    const onConfirm = () => {
      resolved = true;
      cleanup();
      modal.hide();
      resolve(true);
    };

    const onHidden = () => {
      cleanup();
      if (!resolved) {
        resolve(false);
      }
    };

    confirmButton.addEventListener('click', onConfirm);
    modalElement.addEventListener('hidden.bs.modal', onHidden);
    modal.show();
  });
}

// Use this patched version for audit
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveAuditSettings();
  showScanOutput();
  await runAudit(form, runButton, cancelScanButton, resultsBody, (rows, summary) => {
    renderResultsWithStore(rows, resultsBody, () => {});
    updateOriginalTotalFromRows(rows);
    saveCachedScanResults(rows, summary || {});
  }, {
    onStart: (rootPath) => {
      appendTranscodeOutput(`[status] Starting scan in ${rootPath}\n`);
    },
    onFileScanned: (filePath, index, total) => {
      appendTranscodeOutput(`[scan] ${index}/${total} ${filePath}\n`);
    },
    onProgress: (text) => {
      appendTranscodeOutput(`[status] ${text}\n`);
    },
    onDone: (text) => {
      appendTranscodeOutput(`[done] ${text}\n`);
      hideScanOutputLater();
    },
    onCancelled: (text) => {
      appendTranscodeOutput(`[done] ${text}\n`);
      hideScanOutputLater();
    },
    onError: (text) => {
      appendTranscodeOutput(`[error] ${text}\n`);
      hideScanOutputLater();
    }
  });
});

// In transcodeBtn click handler:
// Replace:
//   showSpinnerModal('Transcoding, please wait...');
//   ...
//   hideSpinnerModal();
// With nothing (just disable/enable button as before)

// In form submit handler:
// Replace:
//   showSpinnerModal('Scanning, please wait...');
//   ...
//   hideSpinnerModal();
// With nothing (just run the audit)

transcodeBtn.addEventListener('click', async (event) => {
  // Get all checked files
  const checked = Array.from(document.querySelectorAll('.row-checkbox:checked'));
  if (!checked.length) {
    writeUiMessage('warning', 'Please select at least one file to transcode.');
    return;
  }
  // Get file info from table rows
  const rows = checked.map(cb => {
    const rowIdx = parseInt(cb.getAttribute('data-row-index'), 10);
    return window._lastAuditRows?.[rowIdx];
  }).filter(Boolean);
  const transcodeRows = rows.filter(row => row.matches !== true);
  const skippedMatchCount = rows.length - transcodeRows.length;
  if (!rows.length) {
    writeUiMessage('danger', 'Could not resolve selected files. Please re-run the scan.');
    return;
  }
  if (!transcodeRows.length) {
    writeUiMessage('warning', 'All selected files are already MATCH and were skipped.');
    return;
  }
  // Get audit settings
  const formData = new FormData(form);
  const videoCodec = formData.get('videoCodec') || '';
  const audioCodec = formData.get('audioCodec') || '';
  const videoBitrate = formData.get('videoBitrate') || '';
  const audioChannels = formData.get('audioChannels') || '';
  const deleteOriginal = document.getElementById('delete-original')?.checked === true;
  const savedSettings = loadSavedAuditSettings();
  const transcodeLocation = (savedSettings.transcodeLocation || '').trim();
  const pauseBatteryPct = savedSettings.pauseBatteryPct || '';
  const startBatteryPct = savedSettings.startBatteryPct || '';
  const saveTranscodeLog = savedSettings.saveTranscodeLog === true;
  const capBitrateToSource = savedSettings.capBitrateToSource !== false;
  saveAuditSettings();

  if (deleteOriginal) {
    const confirmed = await confirmDeleteOriginalWarning();
    if (!confirmed) {
      writeUiMessage('warning', 'Transcode cancelled. Original files were not deleted.');
      return;
    }
  }

  // Send to backend
  transcodeBtn.disabled = true;
  showTranscodeOutput();
  startTranscodeEventStream();
  try {
    const res = await fetch('/api/transcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: transcodeRows.map(r => r.fullPath || r.filePath),
        videoCodec,
        audioCodec,
        videoBitrate,
        audioChannels,
        deleteOriginal,
        transcodeLocation,
        pauseBatteryPct,
        startBatteryPct,
        saveTranscodeLog,
        capBitrateToSource
      })
    });
    const data = await res.json();
    if (Array.isArray(data.results)) {
      updateTranscodeSavingsSummary(data.results);
    }
    if (data?.summary) {
      renderAppSavingsSummary(data.summary);
    }
    if (typeof data?.runLogPath === 'string' && data.runLogPath) {
      appendTranscodeOutput(`[status] Transcode run log: ${data.runLogPath}\n`);
    }
    if (!res.ok || !data.ok) {
      const failedReasons = Array.isArray(data?.failedReasons) ? data.failedReasons : [];
      const powerReasons = failedReasons.filter((reason) => isPowerManagementCondition(reason));
      if (powerReasons.length > 0) {
        renderMessageWithLogLink('warning', `Power management blocked transcode: ${powerReasons.join(' | ')}`, data?.runLogPath);
      } else {
        renderMessageWithLogLink('danger', data.error || 'Transcode failed.', data?.runLogPath);
      }
      return;
    }
    if (Array.isArray(data.results) && data.results.length > 0) {
      await refreshRowsAfterTranscode(data.results).catch((error) => {
        appendTranscodeOutput(`[status] Incremental table refresh failed: ${error.message}\n`);
      });
    }
    const skippedNote = skippedMatchCount > 0 ? ` Skipped ${skippedMatchCount} MATCH file(s).` : '';
    renderMessageWithLogLink('success', `${data.message || 'Transcode started.'}${skippedNote}`, data?.runLogPath);
  } catch (err) {
    renderMessageWithLogLink('danger', err.message, null);
  } finally {
    setActiveTranscodingRow(null);
    hideTranscodeOutputLater();
    closeTranscodeEventStream();
    transcodeBtn.disabled = false;
  }
});

// Ensure info button popup works
resultsBody.addEventListener('click', function (e) {
  const btn = e.target.closest('button[data-row-index]');
  if (btn) {
    const idx = parseInt(btn.getAttribute('data-row-index'), 10);
    const row = window._lastAuditRows?.[idx];
    if (!row) return;

    // Populate modal
    document.getElementById('detailsFilePath').textContent = row.fullPath || row.filePath || row.fileName;
    const rowState = getRowState(row);
    document.getElementById('detailsStatusBadge').textContent = getStatusLabel(rowState);
    document.getElementById('detailsIssueBadge').textContent = `${row.issues || 0} issues`;
    const detailsList = document.getElementById('detailsList');
    detailsList.innerHTML = '';
    if (row.details && Array.isArray(row.details) && row.details.length > 0) {
      row.details.forEach(item => {
        const li = document.createElement('li');
        li.className = 'list-group-item';
        li.textContent = item;
        detailsList.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.className = 'list-group-item text-muted';
      li.textContent = 'No issue details available.';
      detailsList.appendChild(li);
    }
    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('detailsModal'));
    modal.show();
  }
});
