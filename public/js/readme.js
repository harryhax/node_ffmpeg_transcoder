const statusEl = document.getElementById('readme-status');
const contentEl = document.getElementById('readme-content');

async function loadReadme() {
  try {
    const response = await fetch('/api/readme');
    const payload = await response.json();

    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || 'Failed to load README.');
    }

    const content = typeof payload.content === 'string' ? payload.content : '';
    if (statusEl) {
      statusEl.textContent = '';
    }
    if (contentEl) {
      contentEl.textContent = content;
    }
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = `Unable to load README: ${error.message || 'unknown error'}`;
      statusEl.classList.remove('text-muted');
      statusEl.classList.add('text-danger');
    }
  }
}

loadReadme();