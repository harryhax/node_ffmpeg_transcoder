const CODEC_VISIBILITY_KEY = 'codecVisibilityMode';
const AUDIT_SETTINGS_KEY = 'auditFormSettings';
const SMOKE_SETTINGS_KEY = 'smokeGeneratorSettings';

const showCommonCodecsCheckbox = document.getElementById('show-common-codecs');
const codecSettingStatus = document.getElementById('codec-setting-status');
const transcodeLocationSetting = document.getElementById('transcode-location-setting');
const ffmpegDirSetting = document.getElementById('ffmpeg-dir-setting');
const ffprobeDirSetting = document.getElementById('ffprobe-dir-setting');
const videoBitrateToleranceSetting = document.getElementById('video-bitrate-tolerance-setting');
const pauseBatteryPctSetting = document.getElementById('pause-battery-pct-setting');
const startBatteryPctSetting = document.getElementById('start-battery-pct-setting');
const saveTranscodeLogSetting = document.getElementById('save-transcode-log-setting');
const advancedSettingStatus = document.getElementById('advanced-setting-status');
let toolPathSaveTimeout = null;

function loadAuditSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(AUDIT_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveAuditSettingsPatch(patch) {
  const current = loadAuditSettings();
  const merged = { ...current, ...patch };
  globalThis.localStorage?.setItem(AUDIT_SETTINGS_KEY, JSON.stringify(merged));
}

function renderAdvancedSettingStatus(text = 'Saved. These defaults are used by the audit/transcode page.') {
  if (!advancedSettingStatus) {
    return;
  }
  advancedSettingStatus.textContent = text;
}

async function loadToolPathsFromServer() {
  const response = await fetch('/api/options/tool-paths');
  const data = await response.json();
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || 'Unable to load ffmpeg/ffprobe folder settings.');
  }
  return data.toolPaths || {};
}

async function saveToolPathsToServer() {
  const ffmpegDir = ffmpegDirSetting ? ffmpegDirSetting.value.trim() : '';
  const ffprobeDir = ffprobeDirSetting ? ffprobeDirSetting.value.trim() : '';

  const response = await fetch('/api/options/tool-paths', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ffmpegDir, ffprobeDir })
  });
  const data = await response.json();
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || 'Unable to save ffmpeg/ffprobe folder settings.');
  }
  return data.toolPaths || {};
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

function getCodecVisibilityMode() {
  return globalThis.localStorage?.getItem(CODEC_VISIBILITY_KEY) || 'all';
}

function setCodecVisibilityMode(mode) {
  globalThis.localStorage?.setItem(CODEC_VISIBILITY_KEY, mode);
}

function renderCodecSettingStatus(isCommonOnly) {
  if (!codecSettingStatus) {
    return;
  }

  codecSettingStatus.textContent = isCommonOnly
    ? 'Audit page will show the top 10 most common codecs.'
    : 'Audit page will show all available codecs.';
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
    transcodeLocationSetting.addEventListener('input', () => {
      saveAuditSettingsPatch({ transcodeLocation: transcodeLocationSetting.value.trim() });
      renderAdvancedSettingStatus();
    });
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

  if (ffmpegDirSetting || ffprobeDirSetting) {
    loadToolPathsFromServer()
      .then((toolPaths) => {
        if (ffmpegDirSetting) {
          ffmpegDirSetting.value = typeof toolPaths.ffmpegDir === 'string' ? toolPaths.ffmpegDir : '';
          ffmpegDirSetting.addEventListener('input', scheduleToolPathSave);
        }
        if (ffprobeDirSetting) {
          ffprobeDirSetting.value = typeof toolPaths.ffprobeDir === 'string' ? toolPaths.ffprobeDir : '';
          ffprobeDirSetting.addEventListener('input', scheduleToolPathSave);
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
    const response = await fetch('/api/options/codecs');
    const data = await response.json();
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || 'Unable to fetch codecs.');
    }

    const videoCodecs = Array.isArray(data.videoCodecs) ? data.videoCodecs : [];
    availableSmokeVideoCodecs = videoCodecs;
    const smokeSaved = loadSmokeSettings();
    const hasSavedSelection = Object.prototype.hasOwnProperty.call(smokeSaved, 'selectedVideoCodecs');
    const selectedCodecs = hasSavedSelection
      ? (Array.isArray(smokeSaved.selectedVideoCodecs) ? smokeSaved.selectedVideoCodecs : [])
      : getDefaultMostCommonCodecs(availableSmokeVideoCodecs);

    if (!hasSavedSelection) {
      saveSmokeSettingsPatch({ selectedVideoCodecs: selectedCodecs });
    }

    renderSmokeCodecCheckboxes(availableSmokeVideoCodecs, selectedCodecs);

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
  try {
    const raw = globalThis.localStorage?.getItem(SMOKE_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveSmokeSettingsPatch(patch) {
  const current = loadSmokeSettings();
  const merged = { ...current, ...patch };
  globalThis.localStorage?.setItem(SMOKE_SETTINGS_KEY, JSON.stringify(merged));
}

function normalizeSmokeDurationRange(minRaw, maxRaw) {
  const parsedMin = Number.parseFloat(String(minRaw ?? ''));
  const parsedMax = Number.parseFloat(String(maxRaw ?? ''));
  let min = Number.isFinite(parsedMin) ? parsedMin : 30;
  let max = Number.isFinite(parsedMax) ? parsedMax : 120;
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
  let max = Number.isFinite(parsedMax) ? parsedMax : 9000;
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
    smokeCountInput.value = String(smokeSaved.count ?? 20);
    smokeCountInput.addEventListener('input', () => {
      saveSmokeSettingsPatch({ count: smokeCountInput.value });
    });
  }

  if (smokeMinDurationSecInput && smokeMaxDurationSecInput) {
    const savedMinDuration = smokeSaved.minDurationSec ?? smokeSaved.minDurationMin ?? smokeSaved.minSizeMb;
    const savedMaxDuration = smokeSaved.maxDurationSec ?? smokeSaved.maxDurationMin ?? smokeSaved.maxSizeMb;
    smokeMinDurationSecInput.value = String(savedMinDuration ?? 30);
    smokeMaxDurationSecInput.value = String(savedMaxDuration ?? 120);

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
    smokeMaxBitrateKbpsInput.value = String(smokeSaved.maxBitrateKbps ?? 9000);

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
    const smokeCount = Number.parseInt(formData.get('smokeCount') || '20', 10);
    const smokeMode = formData.get('smokeMode') || 'random';
    const durationRange = normalizeSmokeDurationRange(
      formData.get('smokeMinDurationSec') || 30,
      formData.get('smokeMaxDurationSec') || 120
    );
    const bitrateRange = normalizeSmokeBitrateRange(
      formData.get('smokeMinBitrateKbps') || 2500,
      formData.get('smokeMaxBitrateKbps') || 9000
    );
    const useGpuCodecsOnly = false;
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
      const response = await fetch('/api/smoke', {
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

      const data = await response.json();
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
      const response = await fetch('/api/smoke/cancel', { method: 'POST' });
      const data = await response.json();
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
