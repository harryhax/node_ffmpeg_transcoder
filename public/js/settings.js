import { fetchJson, fetchJsonOrThrow } from './api.js';
import {
  readJsonStorage,
  readStringStorage,
  removeStorageKeys,
  writeJsonStorage,
  writeStringStorage,
} from './storage.js';

const CODEC_VISIBILITY_KEY = 'codecVisibilityMode';
const AUDIT_SETTINGS_KEY = 'auditFormSettings';
const SMOKE_SETTINGS_KEY = 'smokeGeneratorSettings';
const DEFAULT_SCAN_EXTENSIONS = '.mp4,.mkv,.mov,.avi,.wmv,.flv,.webm,.m4v,.mpg,.mpeg,.ts';

const showCommonCodecsCheckbox = document.getElementById('show-common-codecs');
const codecSettingStatus = document.getElementById('codec-setting-status');
const transcodeLocationSetting = document.getElementById('transcode-location-setting');
const transcodeLocationPicker = document.getElementById('transcode-location-picker');
const ffmpegDirSetting = document.getElementById('ffmpeg-dir-setting');
const ffmpegDirPicker = document.getElementById('ffmpeg-dir-picker');
const ffprobeDirSetting = document.getElementById('ffprobe-dir-setting');
const ffprobeDirPicker = document.getElementById('ffprobe-dir-picker');
const videoBitrateToleranceSetting = document.getElementById('video-bitrate-tolerance-setting');
const scanExtensionsSetting = document.getElementById('scan-extensions-setting');
const pauseBatteryPctSetting = document.getElementById('pause-battery-pct-setting');
const startBatteryPctSetting = document.getElementById('start-battery-pct-setting');
const saveTranscodeLogSetting = document.getElementById('save-transcode-log-setting');
const capBitrateToSourceSetting = document.getElementById('cap-bitrate-to-source-setting');
const resetDefaultsBtn = document.getElementById('reset-defaults-btn');
const advancedSettingStatus = document.getElementById('advanced-setting-status');
let toolPathSaveTimeout = null;

async function loadDirectoryPicker(valueInput, picker, {
  emptyLabel = '',
  maxDepth = 1
} = {}) {
  if (!valueInput || !picker) {
    return;
  }

  const currentValue = String(valueInput.value || '').trim();
  const base = currentValue || '.';
  const query = new URLSearchParams({ base, maxDepth: String(maxDepth) });
  const data = await fetchJsonOrThrow(`/api/options/directories?${query.toString()}`, undefined, 'Unable to load directories.');

  const options = [];

  if (emptyLabel) {
    const selected = currentValue ? '' : ' selected';
    options.push(`<option value=""${selected}>${escapeHtml(emptyLabel)}</option>`);
  }

  if (typeof data.parent === 'string' && data.parent) {
    options.push(`<option value="${escapeHtml(data.parent)}">← Back ...</option>`);
  }

  const discoveredDirs = Array.isArray(data.directories) ? data.directories : [];
  if (currentValue && !discoveredDirs.includes(currentValue)) {
    options.push(`<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue)}</option>`);
  }

  for (const dir of discoveredDirs) {
    const selected = dir === currentValue ? ' selected' : '';
    options.push(`<option value="${escapeHtml(dir)}"${selected}>${escapeHtml(dir)}</option>`);
  }

  picker.innerHTML = options.join('');
}

function normalizeScanExtensionsInput(value) {
  const parts = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith('.') ? item : `.${item}`));

  return Array.from(new Set(parts)).join(',');
}

function loadAuditSettings() {
  const parsed = readJsonStorage(AUDIT_SETTINGS_KEY, {});
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function saveAuditSettingsPatch(patch) {
  const current = loadAuditSettings();
  const merged = { ...current, ...patch };
  writeJsonStorage(AUDIT_SETTINGS_KEY, merged);
}

function renderAdvancedSettingStatus(text = 'Saved. These defaults are used by the audit/transcode page.') {
  if (!advancedSettingStatus) {
    return;
  }
  advancedSettingStatus.textContent = text;
}

async function loadToolPathsFromServer() {
  const data = await fetchJsonOrThrow('/api/options/tool-paths', undefined, 'Unable to load ffmpeg/ffprobe folder settings.');
  return data.toolPaths || {};
}

async function saveToolPathsToServer() {
  const ffmpegDir = ffmpegDirSetting ? ffmpegDirSetting.value.trim() : '';
  const ffprobeDir = ffprobeDirSetting ? ffprobeDirSetting.value.trim() : '';

  const data = await fetchJsonOrThrow('/api/options/tool-paths', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ffmpegDir, ffprobeDir })
  }, 'Unable to save ffmpeg/ffprobe folder settings.');
  return data.toolPaths || {};
}

async function resetToolPathsToDefaults() {
  await fetchJsonOrThrow('/api/options/tool-paths', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ffmpegDir: '', ffprobeDir: '' })
  }, 'Unable to reset ffmpeg/ffprobe folder settings.');
}

function clearAppLocalSettings() {
  removeStorageKeys([
    CODEC_VISIBILITY_KEY,
    AUDIT_SETTINGS_KEY,
    SMOKE_SETTINGS_KEY,
  ]);
}

function scheduleToolPathSave() {
  if (toolPathSaveTimeout) {
    clearTimeout(toolPathSaveTimeout);
  }

  toolPathSaveTimeout = setTimeout(async () => {
    try {
      const saved = await saveToolPathsToServer();
      if (ffmpegDirSetting) {
        ffmpegDirSetting.value = typeof saved.ffmpegDir === 'string' ? saved.ffmpegDir : '';
      }
      if (ffprobeDirSetting) {
        ffprobeDirSetting.value = typeof saved.ffprobeDir === 'string' ? saved.ffprobeDir : '';
      }
      renderAdvancedSettingStatus('Saved ffmpeg/ffprobe folder overrides. Blank uses system default.');
    } catch (error) {
      renderAdvancedSettingStatus(`Failed to save ffmpeg/ffprobe folder overrides: ${error.message}`);
    }
  }, 300);
}

if (resetDefaultsBtn) {
  resetDefaultsBtn.addEventListener('click', async () => {
    resetDefaultsBtn.disabled = true;
    try {
      await resetToolPathsToDefaults();
      clearAppLocalSettings();
      renderAdvancedSettingStatus('Defaults restored for the entire application. Reloading...');
      globalThis.setTimeout(() => {
        globalThis.location.reload();
      }, 150);
    } catch (error) {
      renderAdvancedSettingStatus(`Failed to reset defaults: ${error.message}`);
      resetDefaultsBtn.disabled = false;
    }
  });
}

function getCodecVisibilityMode() {
  return readStringStorage(CODEC_VISIBILITY_KEY, 'all') || 'all';
}

function setCodecVisibilityMode(mode) {
  writeStringStorage(CODEC_VISIBILITY_KEY, mode);
}

function renderCodecSettingStatus(isCommonOnly) {
  if (!codecSettingStatus) {
    return;
  }

  codecSettingStatus.textContent = isCommonOnly
    ? 'Home page will show the top 10 most common codecs.'
    : 'Home page will show all available codecs.';
}

if (showCommonCodecsCheckbox) {
  const isCommonOnly = getCodecVisibilityMode() === 'common';
  showCommonCodecsCheckbox.checked = isCommonOnly;
  renderCodecSettingStatus(isCommonOnly);

  showCommonCodecsCheckbox.addEventListener('change', () => {
    const checked = showCommonCodecsCheckbox.checked;
    setCodecVisibilityMode(checked ? 'common' : 'all');
    renderCodecSettingStatus(checked);
  });
}

{
  const saved = loadAuditSettings();
  if (transcodeLocationSetting) {
    transcodeLocationSetting.value = typeof saved.transcodeLocation === 'string' ? saved.transcodeLocation : '';
    if (transcodeLocationPicker) {
      loadDirectoryPicker(transcodeLocationSetting, transcodeLocationPicker, { emptyLabel: 'Not set (optional)', maxDepth: 1 })
        .catch((error) => {
          renderAdvancedSettingStatus(`Failed to load transcode folders: ${error.message}`);
        });

      transcodeLocationPicker.addEventListener('change', async () => {
        transcodeLocationSetting.value = transcodeLocationPicker.value || '';
        saveAuditSettingsPatch({ transcodeLocation: transcodeLocationSetting.value.trim() });
        renderAdvancedSettingStatus();
        try {
          await loadDirectoryPicker(transcodeLocationSetting, transcodeLocationPicker, { emptyLabel: 'Not set (optional)', maxDepth: 1 });
        } catch (error) {
          renderAdvancedSettingStatus(`Failed to load transcode folders: ${error.message}`);
        }
      });
    }
  }

  if (videoBitrateToleranceSetting) {
    videoBitrateToleranceSetting.value = typeof saved.videoBitrateTolerancePct === 'string'
      ? saved.videoBitrateTolerancePct
      : '10';
    videoBitrateToleranceSetting.addEventListener('input', () => {
      const value = Number.parseInt(videoBitrateToleranceSetting.value || '10', 10);
      const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 10;
      videoBitrateToleranceSetting.value = String(safe);
      saveAuditSettingsPatch({ videoBitrateTolerancePct: String(safe) });
      renderAdvancedSettingStatus();
    });
  }

  if (scanExtensionsSetting) {
    const normalizedSavedExtensions = normalizeScanExtensionsInput(saved.scanExtensions || DEFAULT_SCAN_EXTENSIONS);
    scanExtensionsSetting.value = normalizedSavedExtensions;
    if (typeof saved.scanExtensions !== 'string' || !saved.scanExtensions.trim()) {
      saveAuditSettingsPatch({ scanExtensions: normalizedSavedExtensions });
    }
    scanExtensionsSetting.addEventListener('input', () => {
      const normalized = normalizeScanExtensionsInput(scanExtensionsSetting.value);
      scanExtensionsSetting.value = normalized;
      saveAuditSettingsPatch({ scanExtensions: normalized });
      renderAdvancedSettingStatus();
    });
  }

  if (pauseBatteryPctSetting) {
    pauseBatteryPctSetting.value = typeof saved.pauseBatteryPct === 'string' ? saved.pauseBatteryPct : '';
    pauseBatteryPctSetting.addEventListener('input', () => {
      const raw = pauseBatteryPctSetting.value.trim();
      if (raw === '') {
        saveAuditSettingsPatch({ pauseBatteryPct: '' });
        renderAdvancedSettingStatus();
        return;
      }

      const value = Number.parseInt(raw, 10);
      const safe = Number.isFinite(value) ? Math.max(1, Math.min(99, value)) : 1;
      pauseBatteryPctSetting.value = String(safe);
      saveAuditSettingsPatch({ pauseBatteryPct: String(safe) });
      renderAdvancedSettingStatus();
    });
  }

  if (startBatteryPctSetting) {
    startBatteryPctSetting.value = typeof saved.startBatteryPct === 'string' ? saved.startBatteryPct : '';
    startBatteryPctSetting.addEventListener('input', () => {
      const raw = startBatteryPctSetting.value.trim();
      if (raw === '') {
        saveAuditSettingsPatch({ startBatteryPct: '' });
        renderAdvancedSettingStatus();
        return;
      }

      const value = Number.parseInt(raw, 10);
      const safe = Number.isFinite(value) ? Math.max(1, Math.min(99, value)) : 1;
      startBatteryPctSetting.value = String(safe);
      saveAuditSettingsPatch({ startBatteryPct: String(safe) });
      renderAdvancedSettingStatus();
    });
  }

  if (saveTranscodeLogSetting) {
    saveTranscodeLogSetting.checked = saved.saveTranscodeLog === true;
    saveTranscodeLogSetting.addEventListener('change', () => {
      saveAuditSettingsPatch({ saveTranscodeLog: saveTranscodeLogSetting.checked });
      renderAdvancedSettingStatus();
    });
  }

  if (capBitrateToSourceSetting) {
    capBitrateToSourceSetting.checked = saved.capBitrateToSource !== false;
    capBitrateToSourceSetting.addEventListener('change', () => {
      saveAuditSettingsPatch({ capBitrateToSource: capBitrateToSourceSetting.checked });
      renderAdvancedSettingStatus();
    });
  }

  if (ffmpegDirSetting || ffprobeDirSetting) {
    loadToolPathsFromServer()
      .then((toolPaths) => {
        if (ffmpegDirSetting) {
          ffmpegDirSetting.value = typeof toolPaths.ffmpegDir === 'string' ? toolPaths.ffmpegDir : '';
          if (ffmpegDirPicker) {
            loadDirectoryPicker(ffmpegDirSetting, ffmpegDirPicker, { emptyLabel: 'Use system default', maxDepth: 1 })
              .catch((error) => {
                renderAdvancedSettingStatus(`Failed to load ffmpeg folders: ${error.message}`);
              });

            ffmpegDirPicker.addEventListener('change', async () => {
              ffmpegDirSetting.value = ffmpegDirPicker.value || '';
              scheduleToolPathSave();
              try {
                await loadDirectoryPicker(ffmpegDirSetting, ffmpegDirPicker, { emptyLabel: 'Use system default', maxDepth: 1 });
              } catch (error) {
                renderAdvancedSettingStatus(`Failed to load ffmpeg folders: ${error.message}`);
              }
            });
          }
        }
        if (ffprobeDirSetting) {
          ffprobeDirSetting.value = typeof toolPaths.ffprobeDir === 'string' ? toolPaths.ffprobeDir : '';
          if (ffprobeDirPicker) {
            loadDirectoryPicker(ffprobeDirSetting, ffprobeDirPicker, { emptyLabel: 'Use system default', maxDepth: 1 })
              .catch((error) => {
                renderAdvancedSettingStatus(`Failed to load ffprobe folders: ${error.message}`);
              });

            ffprobeDirPicker.addEventListener('change', async () => {
              ffprobeDirSetting.value = ffprobeDirPicker.value || '';
              scheduleToolPathSave();
              try {
                await loadDirectoryPicker(ffprobeDirSetting, ffprobeDirPicker, { emptyLabel: 'Use system default', maxDepth: 1 });
              } catch (error) {
                renderAdvancedSettingStatus(`Failed to load ffprobe folders: ${error.message}`);
              }
            });
          }
        }
      })
      .catch((error) => {
        renderAdvancedSettingStatus(`Failed to load ffmpeg/ffprobe folder overrides: ${error.message}`);
      });
  }
}

const smokeForm = document.getElementById('smoke-form');
const smokeBtn = document.getElementById('smoke-btn');
const smokeStatus = document.getElementById('smoke-status');
const smokeCountInput = document.getElementById('smoke-count');
const smokeGpuCodecsStatus = document.getElementById('smoke-gpu-codecs-status');
const smokeMinDurationSecInput = document.getElementById('smoke-min-duration-sec');
const smokeMaxDurationSecInput = document.getElementById('smoke-max-duration-sec');
const smokeMinBitrateKbpsInput = document.getElementById('smoke-min-bitrate-kbps');
const smokeMaxBitrateKbpsInput = document.getElementById('smoke-max-bitrate-kbps');
const smokeAdvancedToggle = document.getElementById('smoke-advanced-toggle');
const smokeUseGpuOnlyCheckbox = document.getElementById('smoke-use-gpu-only');
const smokeAdvancedSection = document.getElementById('smoke-advanced-section');
const smokeCodecCheckboxes = document.getElementById('smoke-codec-checkboxes');
const smokeCodecsSelectGpuBtn = document.getElementById('smoke-codecs-select-gpu');
const smokeCodecsSelectAllBtn = document.getElementById('smoke-codecs-select-all');
const smokeOutputWrap = document.getElementById('smoke-output-wrap');
const smokeOutput = document.getElementById('smoke-output');
const smokeWarningAlert = document.getElementById('smoke-warning-alert');
const smokeCancelBtn = document.getElementById('smoke-cancel-inline');

let smokeEventSource = null;
let smokeIsRunning = false;
let availableSmokeVideoCodecs = [];

const MOST_COMMON_SMOKE_CODECS = new Set([
  'hevc_videotoolbox',
  'hevc',
  'h264_videotoolbox',
  'h264',
  'libx265',
  'libx264',
  'vp9',
  'libvpx-vp9',
  'mpeg4',
  'av1'
]);

const LESS_COMMON_SMOKE_CODECS = new Set([
  'prores',
  'prores_aw',
  'prores_ks',
  'mjpeg',
  'dnxhd',
  'theora',
  'wmv2',
  'flv',
  'svq3',
  'cinepak',
  'ffv1',
  'snow'
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bucketSmokeCodec(codec) {
  const value = String(codec || '').toLowerCase();
  if (MOST_COMMON_SMOKE_CODECS.has(value)) {
    return 'Most Common';
  }
  if (LESS_COMMON_SMOKE_CODECS.has(value)) {
    return 'Less Common';
  }
  return 'Other';
}

function groupSmokeCodecs(videoCodecs) {
  const groups = {
    'Most Common': [],
    'Less Common': [],
    Other: []
  };

  for (const codec of videoCodecs) {
    groups[bucketSmokeCodec(codec)].push(codec);
  }

  return groups;
}

function getDefaultMostCommonCodecs(videoCodecs) {
  return (Array.isArray(videoCodecs) ? videoCodecs : [])
    .filter((codec) => MOST_COMMON_SMOKE_CODECS.has(String(codec || '').toLowerCase()));
}

function selectGpuCodecsInList() {
  if (!smokeCodecCheckboxes) {
    return;
  }

  const checkboxes = Array.from(smokeCodecCheckboxes.querySelectorAll('.smoke-codec-checkbox'));
  if (!checkboxes.length) {
    return;
  }

  checkboxes.forEach((checkbox) => {
    checkbox.checked = isGpuCodec(checkbox.value);
  });
  saveSmokeSettingsPatch({ selectedVideoCodecs: getSelectedSmokeVideoCodecs() });
  updateSmokeCodecsSelectAllButtonState();
}

function selectAllCodecsInList() {
  if (!smokeCodecCheckboxes) {
    return;
  }

  const checkboxes = Array.from(smokeCodecCheckboxes.querySelectorAll('.smoke-codec-checkbox'));
  if (!checkboxes.length) {
    return;
  }

  checkboxes.forEach((checkbox) => {
    checkbox.checked = true;
  });
  saveSmokeSettingsPatch({ selectedVideoCodecs: getSelectedSmokeVideoCodecs() });
  updateSmokeCodecsSelectAllButtonState();
}

function updateSmokeCodecsSelectAllButtonState() {
  if (!smokeCodecCheckboxes) {
    return;
  }

  const all = Array.from(smokeCodecCheckboxes.querySelectorAll('.smoke-codec-checkbox'));
  const checked = all.filter((item) => item.checked);

  if (smokeCodecsSelectAllBtn) {
    smokeCodecsSelectAllBtn.textContent = all.length > 0 && checked.length === all.length
      ? 'Deselect All'
      : 'Select All';
  }

  const groupButtons = smokeCodecCheckboxes.querySelectorAll('.smoke-codecs-select-group-btn');
  groupButtons.forEach((button) => {
    const group = button.getAttribute('data-codec-group');
    if (!group) {
      return;
    }
    const groupCheckboxes = Array.from(smokeCodecCheckboxes.querySelectorAll(`.smoke-codec-checkbox[data-codec-group="${group}"]`));
    const groupChecked = groupCheckboxes.filter((item) => item.checked);
    button.textContent = groupCheckboxes.length > 0 && groupChecked.length === groupCheckboxes.length
      ? 'Deselect All'
      : 'Select All';
  });
}

function getSelectedSmokeVideoCodecs() {
  if (!smokeCodecCheckboxes) {
    return [];
  }
  return Array.from(smokeCodecCheckboxes.querySelectorAll('input[type="checkbox"]:checked')).map((item) => item.value);
}

function renderSmokeCodecCheckboxes(videoCodecs, selectedCodecs = []) {
  if (!smokeCodecCheckboxes) {
    return;
  }
  const selectedSet = new Set(selectedCodecs.map((item) => String(item).toLowerCase()));
  const grouped = groupSmokeCodecs(videoCodecs);
  const groupOrder = ['Most Common', 'Less Common', 'Other'];

  smokeCodecCheckboxes.innerHTML = groupOrder.map((groupLabel) => {
    const items = grouped[groupLabel] || [];
    const itemsHtml = items.length
      ? items.map((codec) => {
        const safeCodec = String(codec);
        const safeId = `smoke-codec-${safeCodec.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const checked = selectedSet.has(safeCodec.toLowerCase()) ? ' checked' : '';
        return `
          <div class="col-md-4 col-sm-6">
            <div class="form-check">
              <input class="form-check-input smoke-codec-checkbox" type="checkbox" value="${escapeHtml(safeCodec)}" id="${safeId}"${checked}>
              <label class="form-check-label" for="${safeId}">${escapeHtml(safeCodec)}</label>
            </div>
          </div>
        `;
      }).join('')
      : '<div class="col-12 text-muted small">No codecs in this category.</div>';

    const groupKey = groupLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    return `
      <div class="col-12 mt-2 border rounded p-2">
        <div class="d-flex align-items-center justify-content-between mb-1">
          <div class="fw-semibold">${groupLabel}</div>
          <button class="btn btn-sm btn-outline-secondary smoke-codecs-select-group-btn" type="button" data-codec-group="${groupKey}">Select All</button>
        </div>
        <div class="row g-2">${itemsHtml.replaceAll('smoke-codec-checkbox" type="checkbox"', `smoke-codec-checkbox" type="checkbox" data-codec-group="${groupKey}"`)}</div>
      </div>
    `;
  }).join('');

  smokeCodecCheckboxes.querySelectorAll('.smoke-codec-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      saveSmokeSettingsPatch({ selectedVideoCodecs: getSelectedSmokeVideoCodecs() });
      updateSmokeCodecsSelectAllButtonState();
    });
  });

  smokeCodecCheckboxes.querySelectorAll('.smoke-codecs-select-group-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.getAttribute('data-codec-group');
      if (!group) {
        return;
      }
      const groupCheckboxes = Array.from(smokeCodecCheckboxes.querySelectorAll(`.smoke-codec-checkbox[data-codec-group="${group}"]`));
      if (!groupCheckboxes.length) {
        return;
      }

      const areAllGroupChecked = groupCheckboxes.every((checkbox) => checkbox.checked === true);
      groupCheckboxes.forEach((checkbox) => {
        checkbox.checked = !areAllGroupChecked;
      });
      saveSmokeSettingsPatch({ selectedVideoCodecs: getSelectedSmokeVideoCodecs() });
      updateSmokeCodecsSelectAllButtonState();
    });
  });

  updateSmokeCodecsSelectAllButtonState();
}

if (smokeCodecsSelectAllBtn) {
  smokeCodecsSelectAllBtn.addEventListener('click', () => {
    if (!smokeCodecCheckboxes) {
      return;
    }

    const checkboxes = Array.from(smokeCodecCheckboxes.querySelectorAll('.smoke-codec-checkbox'));
    if (!checkboxes.length) {
      return;
    }

    const areAllChecked = checkboxes.every((checkbox) => checkbox.checked === true);

    checkboxes.forEach((checkbox) => {
      checkbox.checked = !areAllChecked;
    });
    saveSmokeSettingsPatch({ selectedVideoCodecs: getSelectedSmokeVideoCodecs() });
    updateSmokeCodecsSelectAllButtonState();
  });
}

if (smokeCodecsSelectGpuBtn) {
  smokeCodecsSelectGpuBtn.addEventListener('click', () => {
    selectGpuCodecsInList();
  });
}

function setSmokeRunningState(isRunning) {
  smokeIsRunning = isRunning === true;
  if (smokeBtn) {
    smokeBtn.disabled = smokeIsRunning;
  }
  if (smokeWarningAlert) {
    smokeWarningAlert.classList.toggle('d-none', !smokeIsRunning);
  }
  if (smokeCancelBtn) {
    smokeCancelBtn.classList.toggle('d-none', !smokeIsRunning);
    if (!smokeIsRunning) {
      smokeCancelBtn.disabled = false;
    }
  }
  if (smokeIsRunning && smokeOutputWrap) {
    smokeOutputWrap.classList.remove('d-none');
  }
}

function isGpuCodec(codec) {
  const value = String(codec || '').toLowerCase();
  return value.includes('videotoolbox')
    || value.includes('nvenc')
    || value.includes('qsv')
    || value.includes('vaapi')
    || value.includes('amf')
    || value.includes('cuda');
}

async function refreshSmokeGpuCodecStatus() {
  if (!smokeGpuCodecsStatus) {
    return;
  }

  smokeGpuCodecsStatus.textContent = 'Checking available GPU codecs...';
  try {
    const data = await fetchJsonOrThrow('/api/options/codecs', undefined, 'Unable to fetch codecs.');

    const videoCodecs = Array.isArray(data.videoCodecs) ? data.videoCodecs : [];
    availableSmokeVideoCodecs = videoCodecs;
    const smokeSaved = loadSmokeSettings();
    const hasSavedSelection = Object.prototype.hasOwnProperty.call(smokeSaved, 'selectedVideoCodecs');
    const useGpuCodecsOnly = smokeSaved.useGpuCodecsOnly === true;
    const selectedCodecs = hasSavedSelection
      ? (Array.isArray(smokeSaved.selectedVideoCodecs) ? smokeSaved.selectedVideoCodecs : [])
      : availableSmokeVideoCodecs;

    if (!hasSavedSelection) {
      saveSmokeSettingsPatch({ selectedVideoCodecs: selectedCodecs });
    }

    renderSmokeCodecCheckboxes(availableSmokeVideoCodecs, selectedCodecs);

    if (smokeUseGpuOnlyCheckbox) {
      smokeUseGpuOnlyCheckbox.checked = useGpuCodecsOnly;
      if (useGpuCodecsOnly) {
        selectGpuCodecsInList();
      }
    }

    const gpuCodecs = videoCodecs.filter((codec) => isGpuCodec(codec));
    if (!gpuCodecs.length) {
      smokeGpuCodecsStatus.textContent = 'Detected GPU codecs: none';
      return;
    }

    smokeGpuCodecsStatus.textContent = `Detected GPU codecs: ${gpuCodecs.join(', ')}`;
  } catch (error) {
    smokeGpuCodecsStatus.textContent = `Detected GPU codecs: unavailable (${error.message})`;
  }
}

function appendSmokeOutput(text) {
  if (!smokeOutput) {
    return;
  }
  const stamp = new Date().toLocaleTimeString();
  smokeOutput.textContent += `[${stamp}] ${text}\n`;
  smokeOutput.scrollTop = smokeOutput.scrollHeight;
}

function closeSmokeEventStream() {
  if (smokeEventSource) {
    smokeEventSource.close();
    smokeEventSource = null;
  }
}

function startSmokeEventStream() {
  closeSmokeEventStream();
  smokeEventSource = new EventSource('/api/smoke/stream');

  smokeEventSource.addEventListener('state', (event) => {
    try {
      const payload = JSON.parse(event.data);
      setSmokeRunningState(payload?.inProgress === true);
    } catch {
    }
  });

  smokeEventSource.addEventListener('status', (event) => {
    appendSmokeOutput(`[status] ${event.data}`);
  });

  smokeEventSource.addEventListener('log', (event) => {
    appendSmokeOutput(event.data);
  });

  smokeEventSource.addEventListener('done', (event) => {
    appendSmokeOutput(`[done] ${event.data}`);
    setSmokeRunningState(false);
  });

  smokeEventSource.addEventListener('error', () => {
  });
}

function startSmokeOutputWindow() {
  if (smokeOutputWrap) {
    smokeOutputWrap.classList.remove('d-none');
  }
  if (smokeOutput) {
    smokeOutput.textContent = '';
  }
  setSmokeRunningState(true);
  appendSmokeOutput('Smoke generation started.');
}

function stopSmokeOutputWindow() {
  setSmokeRunningState(false);
}

function loadSmokeSettings() {
  const parsed = readJsonStorage(SMOKE_SETTINGS_KEY, {});
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function saveSmokeSettingsPatch(patch) {
  const current = loadSmokeSettings();
  const merged = { ...current, ...patch };
  writeJsonStorage(SMOKE_SETTINGS_KEY, merged);
}

function normalizeSmokeDurationRange(minRaw, maxRaw) {
  const parsedMin = Number.parseFloat(String(minRaw ?? ''));
  const parsedMax = Number.parseFloat(String(maxRaw ?? ''));
  let min = Number.isFinite(parsedMin) ? parsedMin : 4;
  let max = Number.isFinite(parsedMax) ? parsedMax : 60;
  min = Math.max(1, min);
  max = Math.max(1, max);
  if (min > max) {
    [min, max] = [max, min];
  }
  return { min, max };
}

function normalizeSmokeBitrateRange(minRaw, maxRaw) {
  const parsedMin = Number.parseInt(String(minRaw ?? ''), 10);
  const parsedMax = Number.parseInt(String(maxRaw ?? ''), 10);
  let min = Number.isFinite(parsedMin) ? parsedMin : 2500;
  let max = Number.isFinite(parsedMax) ? parsedMax : 15000;
  min = Math.max(300, Math.min(100000, min));
  max = Math.max(300, Math.min(100000, max));
  if (min > max) {
    [min, max] = [max, min];
  }
  return { min, max };
}

{
  const smokeSaved = loadSmokeSettings();
  if (smokeCountInput) {
    smokeCountInput.value = String(smokeSaved.count ?? 10);
    smokeCountInput.addEventListener('input', () => {
      saveSmokeSettingsPatch({ count: smokeCountInput.value });
    });
  }

  if (smokeMinDurationSecInput && smokeMaxDurationSecInput) {
    const savedMinDuration = smokeSaved.minDurationSec ?? smokeSaved.minDurationMin ?? smokeSaved.minSizeMb;
    const savedMaxDuration = smokeSaved.maxDurationSec ?? smokeSaved.maxDurationMin ?? smokeSaved.maxSizeMb;
    smokeMinDurationSecInput.value = String(savedMinDuration ?? 4);
    smokeMaxDurationSecInput.value = String(savedMaxDuration ?? 60);

    const persistRange = () => {
      saveSmokeSettingsPatch({
        minDurationSec: smokeMinDurationSecInput.value,
        maxDurationSec: smokeMaxDurationSecInput.value
      });
    };

    smokeMinDurationSecInput.addEventListener('input', persistRange);
    smokeMaxDurationSecInput.addEventListener('input', persistRange);
  }

  if (smokeMinBitrateKbpsInput && smokeMaxBitrateKbpsInput) {
    smokeMinBitrateKbpsInput.value = String(smokeSaved.minBitrateKbps ?? 2500);
    smokeMaxBitrateKbpsInput.value = String(smokeSaved.maxBitrateKbps ?? 15000);

    const persistBitrateRange = () => {
      saveSmokeSettingsPatch({
        minBitrateKbps: smokeMinBitrateKbpsInput.value,
        maxBitrateKbps: smokeMaxBitrateKbpsInput.value
      });
    };

    smokeMinBitrateKbpsInput.addEventListener('input', persistBitrateRange);
    smokeMaxBitrateKbpsInput.addEventListener('input', persistBitrateRange);
  }


  if (smokeAdvancedToggle && smokeAdvancedSection) {
    const setAdvancedVisible = (visible) => {
      smokeAdvancedSection.classList.toggle('d-none', !visible);
      smokeAdvancedToggle.textContent = visible ? 'Advanced (Hide)' : 'Advanced';
    };

    setAdvancedVisible(smokeSaved.showAdvancedSmokeOptions === true);
    smokeAdvancedToggle.addEventListener('click', () => {
      const nextVisible = smokeAdvancedSection.classList.contains('d-none');
      setAdvancedVisible(nextVisible);
      saveSmokeSettingsPatch({ showAdvancedSmokeOptions: nextVisible });
    });
  }

  if (smokeUseGpuOnlyCheckbox) {
    smokeUseGpuOnlyCheckbox.checked = smokeSaved.useGpuCodecsOnly === true;
    smokeUseGpuOnlyCheckbox.addEventListener('change', () => {
      const enabled = smokeUseGpuOnlyCheckbox.checked;
      saveSmokeSettingsPatch({ useGpuCodecsOnly: enabled });
      if (enabled) {
        selectGpuCodecsInList();
      } else {
        selectAllCodecsInList();
      }
    });
  }
}

if (smokeForm && smokeBtn && smokeStatus) {
  smokeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (smokeIsRunning) {
      appendSmokeOutput('Smoke generation is already running.');
      return;
    }
    smokeBtn.disabled = true;
    smokeStatus.textContent = 'Generating smoke fixtures...';
    startSmokeOutputWindow();

    const formData = new FormData(smokeForm);
    const smokeCount = Number.parseInt(formData.get('smokeCount') || '10', 10);
    const smokeMode = formData.get('smokeMode') || 'random';
    const durationRange = normalizeSmokeDurationRange(
      formData.get('smokeMinDurationSec') || 4,
      formData.get('smokeMaxDurationSec') || 60
    );
    const bitrateRange = normalizeSmokeBitrateRange(
      formData.get('smokeMinBitrateKbps') || 2500,
      formData.get('smokeMaxBitrateKbps') || 15000
    );
    const useGpuCodecsOnly = smokeUseGpuOnlyCheckbox?.checked === true;
    const selectedVideoCodecs = getSelectedSmokeVideoCodecs();

    const enteredMinDuration = smokeMinDurationSecInput?.value ?? durationRange.min;
    const enteredMaxDuration = smokeMaxDurationSecInput?.value ?? durationRange.max;
    const enteredMinBitrate = smokeMinBitrateKbpsInput?.value ?? bitrateRange.min;
    const enteredMaxBitrate = smokeMaxBitrateKbpsInput?.value ?? bitrateRange.max;
    saveSmokeSettingsPatch({
      count: smokeCount,
      minDurationSec: enteredMinDuration,
      maxDurationSec: enteredMaxDuration,
      minBitrateKbps: enteredMinBitrate,
      maxBitrateKbps: enteredMaxBitrate,
      useGpuCodecsOnly,
      selectedVideoCodecs
    });
    appendSmokeOutput(`Requested ${smokeCount} file(s), mode=${smokeMode}, length range=${durationRange.min}-${durationRange.max} sec, bitrate range=${bitrateRange.min}-${bitrateRange.max}k, gpuOnly=${useGpuCodecsOnly ? 'yes' : 'no'}, selectedCodecs=${selectedVideoCodecs.length ? selectedVideoCodecs.join(', ') : 'all'}.`);

    try {
      const { response, data } = await fetchJson('/api/smoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          count: smokeCount,
          mode: smokeMode,
          minDurationSec: durationRange.min,
          maxDurationSec: durationRange.max,
          minBitrateKbps: bitrateRange.min,
          maxBitrateKbps: bitrateRange.max,
          useGpuCodecsOnly,
          selectedVideoCodecs
        })
      });

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Smoke test generation failed.');
      }

      smokeStatus.textContent = `Generated ${data.generated} fixture(s) in ${data.outDir}. Length range: ${durationRange.min}-${durationRange.max} sec. Bitrate range: ${bitrateRange.min}-${bitrateRange.max}k. GPU only: ${useGpuCodecsOnly ? 'yes' : 'no'}.`;
      appendSmokeOutput(`Generated ${data.generated} fixture(s) in ${data.outDir}.`);
    } catch (error) {
      smokeStatus.textContent = error.message;
      appendSmokeOutput(`ERROR: ${error.message}`);
    } finally {
      stopSmokeOutputWindow();
      smokeBtn.disabled = false;
    }
  });
}

if (smokeCancelBtn) {
  smokeCancelBtn.addEventListener('click', async () => {
    smokeCancelBtn.disabled = true;
    appendSmokeOutput('Cancelling smoke generation...');
    try {
      const { response, data } = await fetchJson('/api/smoke/cancel', { method: 'POST' });
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Cancel failed.');
      }
      appendSmokeOutput(data.message || 'Cancellation requested.');
    } catch (error) {
      appendSmokeOutput(`ERROR: ${error.message}`);
      smokeCancelBtn.disabled = false;
    }
  });
}

refreshSmokeGpuCodecStatus();
startSmokeEventStream();
