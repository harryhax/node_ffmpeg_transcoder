const CODEC_VISIBILITY_KEY = 'codecVisibilityMode';

const showCommonCodecsCheckbox = document.getElementById('show-common-codecs');
const codecSettingStatus = document.getElementById('codec-setting-status');

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
