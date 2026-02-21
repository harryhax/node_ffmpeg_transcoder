import { escapeHtml, truncateText } from './utils.js';

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
    return `
      <tr class="${rowClass}">
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
          <button type="button" class="btn btn-sm btn-outline-primary d-flex align-items-center justify-content-center" data-row-index="${row.index - 1}" title="Show details"${detailsDisabled} aria-label="Show details">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" class="bi bi-info-circle" viewBox="0 0 16 16">
              <path d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm0 1A8 8 0 1 1 8 0a8 8 0 0 1 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 .877-.252 1.02-.797l.088-.416c.066-.3.115-.347.36-.347h.318l.082-.38-1.738-.287c-.294-.07-.352-.176-.288-.469l.738-3.468c.194-.897-.105-1.319-.808-1.319-.545 0-.877.252-1.02.797l-.088.416c-.066.3-.115.347-.36.347h-.318l-.082.38 1.738.287z"/>
              <circle cx="8" cy="4.5" r="1"/>
            </svg>
          </button>
        </td>
        <td><input type="checkbox" class="row-checkbox" data-row-index="${idx}" /></td>
      </tr>
    `;
  });
  resultsBody.innerHTML = html.join('');
  setupEnhancements(rows);
}
