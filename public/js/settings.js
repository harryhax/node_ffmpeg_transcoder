const CODEC_VISIBILITY_KEY = 'codecVisibilityMode';
const AUDIT_SETTINGS_KEY = 'auditFormSettings';

const showCommonCodecsCheckbox = document.getElementById('show-common-codecs');
const codecSettingStatus = document.getElementById('codec-setting-status');
const transcodeLocationSetting = document.getElementById('transcode-location-setting');
const videoBitrateToleranceSetting = document.getElementById('video-bitrate-tolerance-setting');
const pauseBatteryPctSetting = document.getElementById('pause-battery-pct-setting');
const startBatteryPctSetting = document.getElementById('start-battery-pct-setting');
const saveTranscodeLogSetting = document.getElementById('save-transcode-log-setting');
const advancedSettingStatus = document.getElementById('advanced-setting-status');

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

function renderAdvancedSettingStatus() {
  if (!advancedSettingStatus) {
    return;
  }
  advancedSettingStatus.textContent = 'Saved. These defaults are used by the audit/transcode page.';
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
}

const smokeForm = document.getElementById('smoke-form');
const smokeBtn = document.getElementById('smoke-btn');
const smokeStatus = document.getElementById('smoke-status');

if (smokeForm && smokeBtn && smokeStatus) {
  smokeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    smokeBtn.disabled = true;
    smokeStatus.textContent = 'Generating smoke fixtures...';

    const formData = new FormData(smokeForm);
    const smokeCount = Number.parseInt(formData.get('smokeCount') || '20', 10);
    const smokeMode = formData.get('smokeMode') || 'random';

    try {
      const response = await fetch('/api/smoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: smokeCount, mode: smokeMode })
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Smoke test generation failed.');
      }

      smokeStatus.textContent = `Generated ${data.generated} fixture(s) in ${data.outDir}.`;
    } catch (error) {
      smokeStatus.textContent = error.message;
    } finally {
      smokeBtn.disabled = false;
    }
  });
}
