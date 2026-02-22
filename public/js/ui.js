import { escapeHtml, truncateText, createLogViewerHref } from './utils.js';

function formatSizeMB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.00';
  return (bytes / (1024 * 1024)).toFixed(2);
}

export function getRowState(row) {
  if (row.matches) return 'match';
  const checkValues = Object.values(row.checks || {}).filter((value) => value !== null);
  if (!checkValues.length) return 'no-match';
  const hasPass = checkValues.some((value) => value === true);
  const hasFail = checkValues.some((value) => value === false);
  if (hasPass && hasFail) return 'partial';
  return 'no-match';
}

export function getStatusLabel(rowState) {
  if (rowState === 'match') return 'MATCH';
  if (rowState === 'partial') return 'PARTIAL';
  return 'NO MATCH';
}

export function getRowClass(rowState) {
  if (rowState === 'match') return 'table-success';
  if (rowState === 'partial') return 'table-warning';
  return 'table-danger';
}

export function getCriteriaCellClass(rowState, checkValue) {
  if (rowState === 'partial' && checkValue === true) return 'table-info';
  return '';
}

export function setSelectOptions(select, values, preferredValue = '') {
  const currentValue = preferredValue || select.value;
  const options = ['<option value="">Any</option>'];
  for (const item of values) {
    if (typeof item === 'object' && item.value && item.label) {
      const selected = item.value === currentValue ? ' selected' : '';
      options.push(`<option value="${escapeHtml(item.value)}"${selected}>${escapeHtml(item.label)}</option>`);
    } else {
      const selected = item === currentValue ? ' selected' : '';
      options.push(`<option value="${escapeHtml(item)}"${selected}>${escapeHtml(item)}</option>`);
    }
  }
  select.innerHTML = options.join('');
}

export function renderResults(rows, resultsBody, setupEnhancements) {
  if (!rows.length) {
    resultsBody.innerHTML = '<tr><td colspan="11" class="text-muted">No video files found.</td></tr>';
    return;
  }
  const html = rows.map((row, idx) => {
    const rowState = getRowState(row);
    const statusLabel = getStatusLabel(rowState);
    const rowClass = getRowClass(rowState);
    const fileName = row.fileName || 'unknown';
    const fullPath = row.filePath || row.fullPath || fileName;
    const detailsDisabled = row.issues > 0 ? '' : ' disabled';
    // Use raw size for sorting, MB for display
    const sizeMB = formatSizeMB(row.rawSize || row.size || 0);
    const safeVideoCodec = row.videoCodec || 'unknown';
    const safeVideoBitrate = row.videoBitrate || 'unknown';
    const safeAudioCodec = row.audioCodec || 'unknown';
    const safeAudioChannels = row.audioChannels ?? 'unknown';
    const logHref = row.logPath ? createLogViewerHref(row.logPath) : '';
    const logAction = row.logPath
      ? `<a class="btn btn-sm details-icon-btn" href="${escapeHtml(logHref)}" target="_blank" rel="noopener noreferrer" title="Open log file" aria-label="Open log file">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" class="bi bi-link-45deg" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M4.715 6.542a3.5 3.5 0 0 1 0-4.95l1.6-1.6a3.5 3.5 0 0 1 4.95 4.95l-.611.611a.5.5 0 0 1-.708-.708l.611-.611a2.5 2.5 0 0 0-3.536-3.536l-1.6 1.6a2.5 2.5 0 0 0 0 3.536.5.5 0 0 1-.706.708z"/>
              <path d="M6.586 10.461a.5.5 0 0 1 .708 0 2.5 2.5 0 0 0 3.536 0l1.6-1.6a2.5 2.5 0 1 0-3.536-3.536l-.611.611a.5.5 0 1 1-.708-.708l.611-.611a3.5 3.5 0 0 1 4.95 4.95l-1.6 1.6a3.5 3.5 0 0 1-4.95 0 .5.5 0 0 1 0-.708z"/>
              <path d="M5.354 10.646a.5.5 0 0 1 0-.707l5-5a.5.5 0 1 1 .707.707l-5 5a.5.5 0 0 1-.707 0z"/>
            </svg>
          </a>`
      : '';
    return `
      <tr class="${rowClass}" data-file-path="${escapeHtml(String(row.fullPath || row.filePath || ''))}">
        <td data-sort="${row.index}">${row.index}</td>
        <td>${statusLabel}</td>
        <td data-sort="${row.rawSize || row.size || 0}">${escapeHtml(sizeMB)}</td>
        <td class="${getCriteriaCellClass(rowState, row.checks?.videoCodec)}">${escapeHtml(String(safeVideoCodec))}</td>
        <td class="${getCriteriaCellClass(rowState, row.checks?.videoBitrate)}">${escapeHtml(String(safeVideoBitrate))}</td>
        <td class="${getCriteriaCellClass(rowState, row.checks?.audioCodec)}">${escapeHtml(String(safeAudioCodec))}</td>
        <td data-sort="${Number.isFinite(row.audioChannels) ? row.audioChannels : 0}" class="${getCriteriaCellClass(rowState, row.checks?.audioChannels)}">${escapeHtml(String(safeAudioChannels))}</td>
        <td data-sort="${row.issues}">${row.issues}</td>
        <td>
          <span data-bs-toggle="tooltip" data-bs-title="${escapeHtml(fullPath)}">${escapeHtml(truncateText(fileName))}</span>
        </td>
        <td>
          <div class="d-inline-flex align-items-center gap-1">
          <button type="button" class="btn btn-sm details-icon-btn" data-row-index="${row.index - 1}" title="Show details"${detailsDisabled} aria-label="Show details">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" class="bi bi-file-earmark-code-fill" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M9.293 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.707L9.293 0zM9.5 3.5V1.707L12.293 4.5H10.5a1 1 0 0 1-1-1zM8.646 9.146a.5.5 0 1 1 .708.708L8.207 11l1.147 1.146a.5.5 0 0 1-.708.708l-1.5-1.5a.5.5 0 0 1 0-.708l1.5-1.5zm-2.5 0a.5.5 0 0 1 .708 0l1.5 1.5a.5.5 0 0 1 0 .708l-1.5 1.5a.5.5 0 1 1-.708-.708L7.293 11 6.146 9.854a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
          ${logAction}
          </div>
        </td>
        <td><input type="checkbox" class="row-checkbox" data-row-index="${idx}" /></td>
      </tr>
    `;
  });
  resultsBody.innerHTML = html.join('');
  setupEnhancements(rows);
}
