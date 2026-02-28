function parseJsonSafe(payloadText) {
  if (typeof payloadText !== 'string' || !payloadText.trim()) {
    return null;
  }
  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  const text = String(payload ?? '');
  for (const line of text.split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

export function createTranscodeStreamState() {
  const clients = new Set();

  let latestTranscodeStatusText = null;
  let latestQueuePayloadText = null;
  let latestOverallPayloadText = null;
  let latestProgressPayloadText = null;
  let latestFileStartPayload = null;

  function resetAllSnapshots() {
    latestTranscodeStatusText = null;
    latestQueuePayloadText = null;
    latestOverallPayloadText = null;
    latestProgressPayloadText = null;
    latestFileStartPayload = null;
  }

  function clearProgressSnapshots() {
    latestQueuePayloadText = null;
    latestOverallPayloadText = null;
    latestProgressPayloadText = null;
    latestFileStartPayload = null;
  }

  function broadcastEvent(event, payload) {
    if (event === 'status') {
      latestTranscodeStatusText = String(payload ?? '');
    } else if (event === 'queue') {
      latestQueuePayloadText = String(payload ?? '');
    } else if (event === 'overall') {
      latestOverallPayloadText = String(payload ?? '');
    } else if (event === 'progress') {
      latestProgressPayloadText = String(payload ?? '');
    }

    for (const client of clients) {
      writeSseEvent(client, event, payload);
    }
  }

  function emitFileEvent(event, payload) {
    if (event === 'file-start') {
      latestFileStartPayload = payload;
    } else if ((event === 'file-complete' || event === 'file-failed') && latestFileStartPayload?.file === payload?.file) {
      latestFileStartPayload = null;
    }
    broadcastEvent(event, JSON.stringify(payload));
  }

  function getLiveState(inProgress) {
    return {
      inProgress,
      status: latestTranscodeStatusText,
      queue: parseJsonSafe(latestQueuePayloadText),
      overall: parseJsonSafe(latestOverallPayloadText),
      progress: parseJsonSafe(latestProgressPayloadText),
      activeFile: latestFileStartPayload
    };
  }

  function replayProgressSnapshots(res) {
    if (latestQueuePayloadText) {
      writeSseEvent(res, 'queue', latestQueuePayloadText);
    }
    if (latestOverallPayloadText) {
      writeSseEvent(res, 'overall', latestOverallPayloadText);
    }
    if (latestProgressPayloadText) {
      writeSseEvent(res, 'progress', latestProgressPayloadText);
    }
    if (latestFileStartPayload) {
      writeSseEvent(res, 'file-start', JSON.stringify(latestFileStartPayload));
    }
  }

  function addClient(res) {
    clients.add(res);
  }

  function removeClient(res) {
    clients.delete(res);
  }

  return {
    addClient,
    removeClient,
    writeSseEvent,
    resetAllSnapshots,
    clearProgressSnapshots,
    broadcastEvent,
    emitFileEvent,
    getLiveState,
    replayProgressSnapshots
  };
}