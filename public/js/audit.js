import { setSelectOptions, renderResults } from './ui.js';
import { fetchJson, fetchJsonOrThrow } from './api.js';
import { readJsonStorage } from './storage.js';

const AUDIT_SETTINGS_KEY = 'auditFormSettings';
const DEFAULT_SCAN_EXTENSIONS = '.mp4,.mkv,.mov,.avi,.wmv,.flv,.webm,.m4v,.mpg,.mpeg,.ts';
let activeAuditAbortController = null;

function readSavedBitrateTolerancePct() {
  const parsed = readJsonStorage(AUDIT_SETTINGS_KEY, null);
  const value = parsed?.videoBitrateTolerancePct;
  if (typeof value !== 'string') {
    return '10';
  }
  return value;
}

function readSavedScanExtensions() {
  const parsed = readJsonStorage(AUDIT_SETTINGS_KEY, null);
  if (typeof parsed?.scanExtensions !== 'string') {
    return DEFAULT_SCAN_EXTENSIONS;
  }
  const value = parsed.scanExtensions.trim();
  return value || DEFAULT_SCAN_EXTENSIONS;
}

export async function loadCodecs(videoCodecSelect, audioCodecSelect) {
  const data = await fetchJsonOrThrow('/api/options/codecs', undefined, 'Unable to load codec options.');
  setSelectOptions(videoCodecSelect, data.videoCodecs, 'hevc_videotoolbox');
  setSelectOptions(audioCodecSelect, data.audioCodecs, 'aac');
}

export async function loadDirectories(rootInput, rootPicker) {
  const base = rootInput.value || '.';
  const currentRoot = String(rootInput.value || '').trim() || String(base).trim();
  const query = new URLSearchParams({ base, maxDepth: '1' });
  const data = await fetchJsonOrThrow(`/api/options/directories?${query.toString()}`, undefined, 'Unable to load directories.');
  const options = [];

  if (typeof data.parent === 'string' && data.parent) {
    options.push(`<option value="${data.parent}">← Back ...</option>`);
  }

  const discoveredDirs = Array.isArray(data.directories) ? data.directories : [];
  if (currentRoot && !discoveredDirs.includes(currentRoot)) {
    options.push(`<option value="${currentRoot}" selected>${currentRoot}</option>`);
  }

  for (const dir of discoveredDirs) {
    const selected = dir === rootInput.value ? ' selected' : '';
    options.push(`<option value="${dir}"${selected}>${dir}</option>`);
  }
  rootPicker.innerHTML = options.join('');
}

function setScanButtonState(runButton, cancelScanButton, inProgress) {
  runButton.disabled = inProgress;
  runButton.textContent = inProgress ? 'Scanning...' : 'Scan Files';
  if (!cancelScanButton) {
    return;
  }
  cancelScanButton.classList.toggle('d-none', !inProgress);
  cancelScanButton.disabled = !inProgress;
}

export async function runAudit(form, runButton, cancelScanButton, resultsBody, renderResultsFn, scanHooks = {}) {
  const notify = (eventName, text) => {
    const fn = scanHooks?.[eventName];
    if (typeof fn === 'function') {
      fn(text);
    }
  };

  const formData = new FormData(form);
  const payload = {
    root: formData.get('root') || '.',
    videoCodec: formData.get('videoCodec') || '',
    videoBitrateOp: formData.get('videoBitrateOp') || '=',
    videoBitrate: formData.get('videoBitrate') ? `${formData.get('videoBitrate')}k` : '',
    videoBitrateTolerancePct: readSavedBitrateTolerancePct(),
    audioCodec: formData.get('audioCodec') || '',
    audioChannelsOp: formData.get('audioChannelsOp') || '=',
    audioChannels: formData.get('audioChannels') || ''
  };
  setScanButtonState(runButton, cancelScanButton, true);
  resultsBody.innerHTML = '<tr><td colspan="11" class="text-muted">Scanning files...</td></tr>';
  if (!payload.root || !String(payload.root).trim()) {
    setScanButtonState(runButton, cancelScanButton, false);
    resultsBody.innerHTML = '<tr><td colspan="11" class="text-muted">Scan files to see results.</td></tr>';
    notify('onError', 'Please enter a root folder path on the server.');
    return;
  }

  const abortController = new AbortController();
  activeAuditAbortController = abortController;

  if (cancelScanButton) {
    cancelScanButton.onclick = () => {
      if (activeAuditAbortController) {
        activeAuditAbortController.abort();
        notify('onProgress', 'Cancelling scan...');
      }
    };
  }

  try {
    const listQuery = new URLSearchParams({ root: String(payload.root).trim() });
    if (typeof scanHooks.onStart === 'function') {
      scanHooks.onStart(String(payload.root).trim());
    }
    const scanExtensions = readSavedScanExtensions();
    if (scanExtensions) {
      listQuery.set('scanExtensions', scanExtensions);
    }
    const { response: listResponse, data: listData } = await fetchJson(`/api/audit/files?${listQuery.toString()}`, {
      signal: abortController.signal
    });
    if (!listResponse.ok || !listData.ok) {
      throw new Error(listData.error || 'Unable to list files for scan.');
    }

    const files = Array.isArray(listData.files) ? listData.files : [];
    if (!files.length) {
      resultsBody.innerHTML = '<tr><td colspan="11" class="text-muted">No video files found.</td></tr>';
      notify('onDone', `No video files found in ${listData.rootPath || payload.root}.`);
      return;
    }

    const rows = [];
    let mismatchedCount = 0;
    const rootPath = listData.rootPath || String(payload.root).trim();

    for (let idx = 0; idx < files.length; idx += 1) {
      const filePath = files[idx];
      const { response, data } = await fetchJson('/api/audit/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, files: [filePath] }),
        signal: abortController.signal
      });
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Scan failed for ${filePath}.`);
      }

      const row = data.rows?.[0];
      if (!row) {
        continue;
      }

      row.index = rows.length + 1;
      rows.push(row);
      if (!row.matches) {
        mismatchedCount += 1;
      }

      renderResultsFn([...rows], {
        rootPath,
        checkedCount: rows.length,
        mismatchedCount
      });

      if (typeof scanHooks.onFileScanned === 'function') {
        scanHooks.onFileScanned(filePath, rows.length, files.length);
      }

      const progressText = `Scanning ${rows.length}/${files.length} files in ${rootPath}... Mismatches: ${mismatchedCount}.`;
      notify('onProgress', progressText);
    }

    const doneText = `Checked ${rows.length} files in ${rootPath}. Mismatches: ${mismatchedCount}.`;
    notify('onDone', doneText);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const scannedRows = Array.isArray(globalThis.window?._lastAuditRows) ? globalThis.window._lastAuditRows.length : 0;
      const cancelledText = `Scan cancelled. ${scannedRows} files were scanned.`;
      notify('onCancelled', cancelledText);
    } else {
      resultsBody.innerHTML = '<tr><td colspan="11" class="text-muted">Scan files to see results.</td></tr>';
      notify('onError', error.message);
    }
  } finally {
    activeAuditAbortController = null;
    if (cancelScanButton) {
      cancelScanButton.onclick = null;
    }
    setScanButtonState(runButton, cancelScanButton, false);
  }
}
