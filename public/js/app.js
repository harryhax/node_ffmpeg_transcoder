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
import { renderResults, setSelectOptions, getRowState, getStatusLabel } from './ui.js';
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
const cancelBtn = document.getElementById('cancel-btn');
if (cancelBtn) {
  cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    renderMessage(message, 'info', 'Cancelling transcode...');
    try {
      const res = await fetch('/api/transcode/cancel', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Cancel failed.');
      renderMessage(message, 'success', data.message || 'Transcode cancelled.');
    } catch (err) {
      renderMessage(message, 'danger', err.message);
    } finally {
      cancelBtn.disabled = false;
    }
  });
}

// Helper to sync codec dropdowns
async function syncCodecDropdowns() {
  const response = await fetch('/api/options/codecs');
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load codec options.');
  // Map for display: hevc (CPU) and hevc (GPU)
  const videoCodecOptions = data.videoCodecs.map(c => {
    if (c === 'hevc') return { value: 'hevc', label: 'hevc (CPU)' };
    if (c === 'hevc_videotoolbox') return { value: 'hevc_videotoolbox', label: 'hevc (GPU)' };
    return { value: c, label: c };
  });
  // Prefer GPU codecs by default
  const gpuPreferred = ['hevc_videotoolbox', 'h264_videotoolbox', 'cuda', 'nvenc', 'qsv', 'vaapi'];
  let defaultVideo = videoCodecOptions.find(c => gpuPreferred.includes(c.value))?.value || videoCodecOptions[0]?.value || '';
  setSelectOptions(videoCodecSelect, videoCodecOptions, defaultVideo);
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
  const transcodeLocation = formData.get('transcodeLocation') || '';
  // Send to backend
  transcodeBtn.disabled = true;
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
        deleteOriginal,
        transcodeLocation
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
