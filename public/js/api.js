export async function fetchJson(url, options = undefined) {
  const response = await fetch(url, options);
  const data = await response.json();
  return { response, data };
}

export async function fetchJsonOrThrow(url, options = undefined, fallbackMessage = 'Request failed.') {
  const { response, data } = await fetchJson(url, options);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || fallbackMessage);
  }
  return data;
}
