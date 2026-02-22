import { renderMessage } from './utils.js';
import { setSelectOptions, renderResults } from './ui.js';

const AUDIT_SETTINGS_KEY = 'auditFormSettings';

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
  const query = new URLSearchParams({ base, maxDepth: '3' });
  const response = await fetch(`/api/options/directories?${query.toString()}`);
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load directories.');
  const options = ['<option value="">Select a discovered server folder...</option>'];
  for (const dir of data.directories) {
    const selected = dir === rootInput.value ? ' selected' : '';
    options.push(`<option value="${dir}"${selected}>${dir}</option>`);
  }
  rootPicker.innerHTML = options.join('');
}

export async function runAudit(form, runButton, message, resultsBody, renderResultsFn) {
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
  runButton.disabled = true;
  runButton.textContent = 'Scanning...';
  message.innerHTML = '';
  if (!payload.root || !String(payload.root).trim()) {
    runButton.disabled = false;
    runButton.textContent = 'Scan Files';
    renderMessage(message, 'danger', 'Please enter a root folder path on the server.');
    return;
  }
  try {
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Audit failed.');
    renderMessage(
      message,
      'info',
      `Checked ${data.summary.checkedCount} files in ${data.summary.rootPath}. Mismatches: ${data.summary.mismatchedCount}.`
    );
    renderResultsFn(data.rows, data.summary || {});
  } catch (error) {
    resultsBody.innerHTML = '<tr><td colspan="11" class="text-muted">Scan files to see results.</td></tr>';
    renderMessage(message, 'danger', error.message);
  } finally {
    runButton.disabled = false;
    runButton.textContent = 'Scan Files';
  }
}
