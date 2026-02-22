import { renderMessage } from './utils.js';
import { renderResults, setSelectOptions, getRowState, getStatusLabel } from './ui.js';
import { loadCodecs, loadDirectories, runAudit } from './audit.js';

const CODEC_VISIBILITY_KEY = 'codecVisibilityMode';
const AUDIT_SETTINGS_KEY = 'auditFormSettings';
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

function saveAuditSettings() {
  if (!form) return;
  const data = new FormData(form);
  const existing = loadSavedAuditSettings();
  const payload = {
    root: data.get('root') || '',
    transcodeLocation: typeof existing.transcodeLocation === 'string' ? existing.transcodeLocation : '',
    videoCodec: data.get('videoCodec') || '',
    videoBitrateOp: data.get('videoBitrateOp') || '>=',
    videoBitrate: data.get('videoBitrate') || '',
    videoBitrateTolerancePct: typeof existing.videoBitrateTolerancePct === 'string' ? existing.videoBitrateTolerancePct : '10',
    audioCodec: data.get('audioCodec') || '',
    audioChannelsOp: data.get('audioChannelsOp') || '>=',
    audioChannels: data.get('audioChannels') || '',
    pauseBatteryPct: typeof existing.pauseBatteryPct === 'string' ? existing.pauseBatteryPct : '',
    startBatteryPct: typeof existing.startBatteryPct === 'string' ? existing.startBatteryPct : '',
    saveTranscodeLog: existing.saveTranscodeLog === true,
    deleteOriginal: data.get('deleteOriginal') === 'on'
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
    deleteOriginalInput.checked = settings.deleteOriginal === true;
  }
}

// DOM elements
const form = document.getElementById('audit-form');
const runButton = document.getElementById('run-btn');
const message = document.getElementById('message');
const resultsBody = document.getElementById('results-body');
const rootInput = document.getElementById('root');
const rootPicker = document.getElementById('root-picker');
const rootSection = document.getElementById('root-section');
const toggleRootSectionButton = document.getElementById('toggle-root-section');
const refreshDirsButton = document.getElementById('refresh-dirs');
const videoCodecSelect = document.getElementById('videoCodec');
const audioCodecSelect = document.getElementById('audioCodec');
const transcodeBtn = document.getElementById('transcode-btn');
const selectAllCheckbox = document.getElementById('select-all-checkbox');
const statCpuUsage = document.getElementById('stat-cpu-usage');
const statCpuTemp = document.getElementById('stat-cpu-temp');
const statBattery = document.getElementById('stat-battery');
const statMemory = document.getElementById('stat-memory');
const statUptime = document.getElementById('stat-uptime');

function updateRootToggleLabel(isExpanded) {
  if (!toggleRootSectionButton) {
    return;
  }
  toggleRootSectionButton.textContent = isExpanded ? 'Hide' : 'Show';
}

if (rootSection && toggleRootSectionButton) {
  rootSection.addEventListener('shown.bs.collapse', () => {
    updateRootToggleLabel(true);
  });
  rootSection.addEventListener('hidden.bs.collapse', () => {
    updateRootToggleLabel(false);
  });
}

let transcodeEventSource = null;
let transcodeOutputTimeout = null;

const transcodeOutputWrap = document.createElement('div');
transcodeOutputWrap.className = 'mt-3 d-none';
transcodeOutputWrap.innerHTML = `
  <div class="card border-secondary">
    <div class="card-header py-2 d-flex align-items-center justify-content-between">
      <span>Transcode Progress</span>
      <button id="transcode-cancel-inline" class="btn btn-sm btn-danger d-none" type="button">Cancel</button>
    </div>
    <div class="card-body py-2">
      <pre id="transcode-output" class="mb-0" style="max-height: 240px; overflow: auto; white-space: pre-wrap;"></pre>
    </div>
  </div>
`;
message.insertAdjacentElement('afterend', transcodeOutputWrap);
const transcodeOutput = transcodeOutputWrap.querySelector('#transcode-output');
const inlineCancelBtn = transcodeOutputWrap.querySelector('#transcode-cancel-inline');

function appendTranscodeOutput(text) {
  if (!transcodeOutput) {
    return;
  }
  const next = transcodeOutput.textContent + text;
  const maxChars = 18000;
  transcodeOutput.textContent = next.length > maxChars ? next.slice(next.length - maxChars) : next;
  transcodeOutput.scrollTop = transcodeOutput.scrollHeight;
}

function showTranscodeOutput() {
  if (transcodeOutputTimeout) {
    clearTimeout(transcodeOutputTimeout);
    transcodeOutputTimeout = null;
  }
  transcodeOutputWrap.classList.remove('d-none');
  transcodeOutput.textContent = '';
  if (inlineCancelBtn) {
    inlineCancelBtn.classList.remove('d-none');
    inlineCancelBtn.disabled = false;
  }
}

function hideTranscodeOutputLater() {
  transcodeOutputTimeout = setTimeout(() => {
    if (inlineCancelBtn) {
      inlineCancelBtn.classList.add('d-none');
      inlineCancelBtn.disabled = false;
    }
    transcodeOutputWrap.classList.add('d-none');
    transcodeOutput.textContent = '';
    transcodeOutputTimeout = null;
  }, 1200);
}

function closeTranscodeEventStream() {
  if (transcodeEventSource) {
    transcodeEventSource.close();
    transcodeEventSource = null;
  }
}

function startTranscodeEventStream() {
  closeTranscodeEventStream();
  transcodeEventSource = new EventSource('/api/transcode/stream');

  transcodeEventSource.addEventListener('status', (event) => {
    appendTranscodeOutput(`[status] ${event.data}\n`);
  });

  transcodeEventSource.addEventListener('log', (event) => {
    appendTranscodeOutput(`${event.data}\n`);
  });

  transcodeEventSource.addEventListener('done', (event) => {
    appendTranscodeOutput(`[done] ${event.data}\n`);
    closeTranscodeEventStream();
    hideTranscodeOutputLater();
  });

  transcodeEventSource.addEventListener('error', () => {
    closeTranscodeEventStream();
    hideTranscodeOutputLater();
  });
}

function formatBytesToGB(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '--';
  }
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '--';
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

async function refreshServerStats() {
  if (!statCpuUsage || !statCpuTemp || !statBattery || !statMemory || !statUptime) {
    return;
  }

  try {
    const response = await fetch('/api/stats');
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Unable to load stats.');
    }

    const stats = data.stats || {};
    statCpuUsage.textContent = Number.isFinite(stats.cpuUsagePercent) ? `${stats.cpuUsagePercent}%` : 'warming up...';
    statCpuTemp.textContent = Number.isFinite(stats.cpuTempC) ? `${stats.cpuTempC.toFixed(1)}°C` : 'unavailable';

    if (stats.battery?.available) {
      const percentText = Number.isFinite(stats.battery.percent) ? `${stats.battery.percent}%` : '--';
      const stateText = stats.battery.state || 'unknown';
      statBattery.textContent = `${percentText} (${stateText})`;
    } else {
      statBattery.textContent = 'unavailable';
    }

    if (stats.memory) {
      const used = stats.memory.totalBytes - stats.memory.freeBytes;
      statMemory.textContent = `${formatBytesToGB(used)} / ${formatBytesToGB(stats.memory.totalBytes)}`;
    } else {
      statMemory.textContent = '--';
    }

    statUptime.textContent = formatUptime(stats.uptimeSeconds);
  } catch {
    statCpuUsage.textContent = '--';
    statCpuTemp.textContent = '--';
    statBattery.textContent = '--';
    statMemory.textContent = '--';
    statUptime.textContent = '--';
  }
}

if (inlineCancelBtn) {
  inlineCancelBtn.addEventListener('click', async () => {
    inlineCancelBtn.disabled = true;
    renderMessage(message, 'info', 'Cancelling transcode...');
    try {
      const res = await fetch('/api/transcode/cancel', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Cancel failed.');
      renderMessage(message, 'success', data.message || 'Transcode cancelled.');
    } catch (err) {
      renderMessage(message, 'danger', err.message);
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
  setSelectOptions(audioCodecSelect, filteredAudioCodecs, savedSettings.audioCodec || 'ac3');
}

// Initial load
(async () => {
  try {
    const savedSettings = loadSavedAuditSettings();
    applySavedAuditSettings(savedSettings);
    await syncCodecDropdowns();
    await loadDirectories(rootInput, rootPicker);
    if (savedSettings.root) {
      rootPicker.value = savedSettings.root;
    }
    if (savedSettings.root && String(savedSettings.root).trim() && rootSection) {
      if (globalThis.bootstrap?.Collapse) {
        const collapse = new globalThis.bootstrap.Collapse(rootSection, { toggle: false });
        collapse.hide();
      } else {
        rootSection.classList.remove('show');
      }
      updateRootToggleLabel(false);
    } else {
      updateRootToggleLabel(true);
    }
    renderMessage(message, 'info', 'Choose a server folder path, then run the audit.');
  } catch (error) {
    renderMessage(message, 'danger', error.message);
  }
})();

refreshServerStats();
setInterval(refreshServerStats, 5000);

form.addEventListener('change', saveAuditSettings);
form.addEventListener('input', saveAuditSettings);

rootPicker.addEventListener('change', () => {
  if (rootPicker.value) {
    rootInput.value = rootPicker.value;
  }
});

refreshDirsButton.addEventListener('click', async () => {
  try {
    await loadDirectories(rootInput, rootPicker);
    renderMessage(message, 'info', 'Server folder list refreshed.');
  } catch (error) {
    renderMessage(message, 'danger', error.message);
  }
});

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
}

// Use this patched version for audit
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveAuditSettings();
  await runAudit(form, runButton, message, resultsBody, (rows) => renderResultsWithStore(rows, resultsBody, () => {}));
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
    renderMessage(message, 'warning', 'Please select at least one file to transcode.');
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
    renderMessage(message, 'danger', 'Could not resolve selected files. Please re-run the audit.');
    return;
  }
  if (!transcodeRows.length) {
    renderMessage(message, 'warning', 'All selected files are already MATCH and were skipped.');
    return;
  }
  // Get audit settings
  const formData = new FormData(form);
  const videoCodec = formData.get('videoCodec') || '';
  const audioCodec = formData.get('audioCodec') || '';
  const videoBitrate = formData.get('videoBitrate') || '';
  const audioChannels = formData.get('audioChannels') || '';
  const deleteOriginal = formData.get('deleteOriginal') === 'on';
  const savedSettings = loadSavedAuditSettings();
  const transcodeLocation = (savedSettings.transcodeLocation || '').trim();
  const pauseBatteryPct = savedSettings.pauseBatteryPct || '';
  const startBatteryPct = savedSettings.startBatteryPct || '';
  const saveTranscodeLog = savedSettings.saveTranscodeLog === true;
  saveAuditSettings();
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
        saveTranscodeLog
      })
    });
    const data = await res.json();
    if (Array.isArray(data.results) && Array.isArray(window._lastAuditRows)) {
      const byFile = new Map(data.results.map((item) => [item.file, item]));
      window._lastAuditRows = window._lastAuditRows.map((row) => {
        const rowFile = row.fullPath || row.filePath;
        const transcodeResult = rowFile ? byFile.get(rowFile) : null;
        if (!transcodeResult) {
          return row;
        }
        return {
          ...row,
          transcodeOutput: transcodeResult.output || row.transcodeOutput,
          logPath: transcodeResult.logPath || row.logPath
        };
      });
      renderResultsWithStore(window._lastAuditRows, resultsBody, () => {});
    }
    if (!res.ok || !data.ok) throw new Error(data.error || 'Transcode failed.');
    const skippedNote = skippedMatchCount > 0 ? ` Skipped ${skippedMatchCount} MATCH file(s).` : '';
    renderMessage(message, 'success', `${data.message || 'Transcode started.'}${skippedNote}`);
  } catch (err) {
    renderMessage(message, 'danger', err.message);
  } finally {
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
