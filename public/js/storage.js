export function readStringStorage(key, fallback = '') {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export function writeStringStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(key, String(value));
  } catch {
  }
}

export function readJsonStorage(key, fallback = null) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJsonStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
  }
}

export function removeStorageKeys(keys = []) {
  for (const key of keys) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
    }
  }
}
