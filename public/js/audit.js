import { renderMessage } from './utils.js';
import { setSelectOptions, renderResults } from './ui.js';

const AUDIT_SETTINGS_KEY = 'auditFormSettings';
let activeAuditAbortController = null;

function readSavedBitrateTolerancePct() {
  try {
    const raw = globalThis.localStorage?.getItem(AUDIT_SETTINGS_KEY);
    if (!raw) {
      return '10';
    }
    const parsed = JSON.parse(raw);
    const value = parsed?.videoBitrateTolerancePct;
    if (typeof value !== 'string') {
      return '10';
    }
    return value;
  } catch {
    return '10';
  }
}

export async function loadCodecs(videoCodecSelect, audioCodecSelect) {
  const response = await fetch('/api/options/codecs');
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load codec options.');
  setSelectOptions(videoCodecSelect, data.videoCodecs, 'hevc');
  setSelectOptions(audioCodecSelect, data.audioCodecs, 'ac3');
}

export async function loadDirectories(rootInput, rootPicker) {
  const base = rootInput.value || '.';
  const query = new URLSearchParams({ base, maxDepth: '1' });
  const response = await fetch(`/api/options/directories?${query.toString()}`);
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load directories.');
  const options = ['<option value="">Select a discovered server folder...</option>'];

  if (typeof data.parent === 'string' && data.parent) {
    options.push(`<option value="${data.parent}">⬅ Go Back (..)</option>`);
  }

  for (const dir of data.directories) {
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

export async function runAudit(form, runButton, cancelScanButton, message, resultsBody, renderResultsFn) {
  const formData = new FormData(form);
  const payload = {
    root: formData.get('root') || '.',
    videoCodec: formData.get('videoCodec') || '',
    videoBitrateOp: formData.get('videoBitrateOp') || '>=',
    videoBitrate: formData.get('videoBitrate') ? `${formData.get('videoBitrate')}k` : '',
    videoBitrateTolerancePct: readSavedBitrateTolerancePct(),
    audioCodec: formData.get('audioCodec') || '',
    audioChannelsOp: formData.get('audioChannelsOp') || '>=',
    audioChannels: formData.get('audioChannels') || ''
  };
  setScanButtonState(runButton, cancelScanButton, true);
  message.innerHTML = '';
  if (!payload.root || !String(payload.root).trim()) {
    setScanButtonState(runButton, cancelScanButton, false);
    renderMessage(message, 'danger', 'Please enter a root folder path on the server.');
    return;
  }

  const abortController = new AbortController();
  activeAuditAbortController = abortController;

  if (cancelScanButton) {
    cancelScanButton.onclick = () => {
      if (activeAuditAbortController) {
        activeAuditAbortController.abort();
        renderMessage(message, 'warning', 'Cancelling scan...');
      }
    };
  }

  try {
    const listQuery = new URLSearchParams({ root: String(payload.root).trim() });
    const listResponse = await fetch(`/api/audit/files?${listQuery.toString()}`, {
      signal: abortController.signal
    });
    const listData = await listResponse.json();
    if (!listResponse.ok || !listData.ok) {
      throw new Error(listData.error || 'Unable to list files for scan.');
    }

    const files = Array.isArray(listData.files) ? listData.files : [];
    if (!files.length) {
      resultsBody.innerHTML = '<tr><td colspan="11" class="text-muted">No video files found.</td></tr>';
      renderMessage(message, 'info', `No video files found in ${listData.rootPath || payload.root}.`);
      return;
    }

    const rows = [];
    let mismatchedCount = 0;
    const rootPath = listData.rootPath || String(payload.root).trim();

    for (let idx = 0; idx < files.length; idx += 1) {
      const filePath = files[idx];
      const response = await fetch('/api/audit/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, files: [filePath] }),
        signal: abortController.signal
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Audit failed for ${filePath}.`);
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

      renderMessage(message, 'info', `Scanning ${rows.length}/${files.length} files in ${rootPath}... Mismatches: ${mismatchedCount}.`);
    }

    renderMessage(
      message,
      'info',
      `Checked ${rows.length} files in ${rootPath}. Mismatches: ${mismatchedCount}.`
    );
  } catch (error) {
    if (error?.name === 'AbortError') {
      const scannedRows = Array.isArray(globalThis.window?._lastAuditRows) ? globalThis.window._lastAuditRows.length : 0;
      renderMessage(message, 'warning', `Scan cancelled. ${scannedRows} files were scanned.`);
    } else {
      resultsBody.innerHTML = '<tr><td colspan="11" class="text-muted">Scan files to see results.</td></tr>';
      renderMessage(message, 'danger', error.message);
    }
  } finally {
    activeAuditAbortController = null;
    if (cancelScanButton) {
      cancelScanButton.onclick = null;
    }
    setScanButtonState(runButton, cancelScanButton, false);
  }
}
