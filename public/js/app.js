// Smoke test generator event handler
const smokeForm = document.getElementById('smoke-form');
const smokeBtn = document.getElementById('smoke-btn');
const smokeStatus = document.getElementById('smoke-status');
if (smokeForm && smokeBtn && smokeStatus) {
  smokeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    smokeBtn.disabled = true;
    smokeStatus.textContent = 'Generating...';
    const formData = new FormData(smokeForm);
    const smokeCount = formData.get('smokeCount') || 20;
    const smokeMode = formData.get('smokeMode') || 'random';
    try {
      const res = await fetch('/api/smoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: smokeCount, mode: smokeMode })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Smoke test failed.');
      smokeStatus.textContent = data.message || 'Smoke test generated.';
    } catch (err) {
      smokeStatus.textContent = err.message;
    } finally {
      smokeBtn.disabled = false;
    }
  });
}
import { renderMessage } from './utils.js';
import { renderResults, setSelectOptions } from './ui.js';
import { loadCodecs, loadDirectories, runAudit } from './audit.js';

// DOM elements
const form = document.getElementById('audit-form');
const runButton = document.getElementById('run-btn');
const message = document.getElementById('message');
const resultsBody = document.getElementById('results-body');
const rootInput = document.getElementById('root');
const rootPicker = document.getElementById('root-picker');
const refreshDirsButton = document.getElementById('refresh-dirs');
const videoCodecSelect = document.getElementById('videoCodec');
const audioCodecSelect = document.getElementById('audioCodec');
const transcodeBtn = document.getElementById('transcode-btn');
const selectAllCheckbox = document.getElementById('select-all-checkbox');

// Helper to sync codec dropdowns
async function syncCodecDropdowns() {
  const response = await fetch('/api/options/codecs');
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load codec options.');
  // Prefer GPU codecs by default
  const gpuPreferred = ['hevc_videotoolbox', 'h264_videotoolbox', 'cuda', 'nvenc', 'qsv', 'vaapi'];
  let defaultVideo = data.videoCodecs.find(c => gpuPreferred.includes(c)) || data.videoCodecs[0] || '';
  setSelectOptions(videoCodecSelect, data.videoCodecs, defaultVideo);
  setSelectOptions(audioCodecSelect, data.audioCodecs, 'ac3');
}

// Initial load
(async () => {
  try {
    await syncCodecDropdowns();
    await loadDirectories(rootInput, rootPicker);
    renderMessage(message, 'info', 'Choose a server folder path, then run the audit.');
  } catch (error) {
    renderMessage(message, 'danger', error.message);
  }
})();

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
    const tooltipNodes = resultsBody.querySelectorAll('[data-bs-toggle="tooltip"]');
    for (const node of tooltipNodes) {
      new globalThis.bootstrap.Tooltip(node);
    }
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
form.removeEventListener('submit', () => {}); // Remove old if present
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await runAudit(form, runButton, message, resultsBody, (rows) => renderResultsWithStore(rows, resultsBody, () => {}));
});

// Add a div for ffmpeg output if not present
let ffmpegOutputDiv = document.getElementById('ffmpeg-output');
if (!ffmpegOutputDiv) {
  ffmpegOutputDiv = document.createElement('div');
  ffmpegOutputDiv.id = 'ffmpeg-output';
  ffmpegOutputDiv.className = 'mt-3 p-2 bg-dark text-light rounded';
  ffmpegOutputDiv.style.fontFamily = 'monospace';
  ffmpegOutputDiv.style.whiteSpace = 'pre-line';
  document.querySelector('main').appendChild(ffmpegOutputDiv);
}

function showFfmpegOutput() {
  ffmpegOutputDiv.textContent = '';
  const evtSource = new EventSource('/api/transcode/stream');
  evtSource.onmessage = (event) => {
    ffmpegOutputDiv.textContent += event.data + '\n';
    ffmpegOutputDiv.scrollTop = ffmpegOutputDiv.scrollHeight;
  };
  evtSource.addEventListener('done', (event) => {
    ffmpegOutputDiv.textContent += '\n' + event.data + '\n';
    evtSource.close();
  });
  evtSource.onerror = () => {
    evtSource.close();
  };
}

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
  if (!rows.length) {
    renderMessage(message, 'danger', 'Could not resolve selected files. Please re-run the audit.');
    return;
  }
  // Get audit settings
  const formData = new FormData(form);
  const videoCodec = formData.get('videoCodec') || '';
  const audioCodec = formData.get('audioCodec') || '';
  const videoBitrate = formData.get('videoBitrate') || '';
  const audioChannels = formData.get('audioChannels') || '';
  const deleteOriginal = formData.get('deleteOriginal') === 'on';
  // Send to backend
  transcodeBtn.disabled = true;
  renderMessage(message, 'info', 'Submitting transcode request...');
  showFfmpegOutput();
  try {
    const res = await fetch('/api/transcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: rows.map(r => r.fullPath || r.filePath),
        videoCodec,
        audioCodec,
        videoBitrate,
        audioChannels,
        deleteOriginal
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Transcode failed.');
    renderMessage(message, 'success', data.message || 'Transcode started.');
  } catch (err) {
    renderMessage(message, 'danger', err.message);
  } finally {
    transcodeBtn.disabled = false;
  }
});
