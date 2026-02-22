// Utility functions for HTML escaping, truncation, and messages
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncateText(value, maxLength = 36) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

export function createLogViewerHref(logPath) {
  if (!logPath) {
    return '';
  }
  const query = new URLSearchParams({ path: String(logPath) });
  return `/api/options/log?${query.toString()}`;
}

export function renderMessage(container, type, text) {
  const withBreaks = escapeHtml(text).replace(/\n/g, '<br />');
  container.innerHTML = `<div class="alert alert-${type}" role="alert">${withBreaks}</div>`;
}
