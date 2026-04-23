// Fetch and inject HTML fragments (no bundler).

const cache = new Map();

async function fetchTemplate(url) {
  if (cache.has(url)) return cache.get(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Template load failed: ${url} (${response.status})`);
  const html = await response.text();
  cache.set(url, html);
  return html;
}

export async function loadTemplate(url, containerId) {
  const container = document.getElementById(containerId);
  if (!container) throw new Error(`Missing template container: ${containerId}`);
  container.innerHTML = await fetchTemplate(url);
  return container;
}

export async function ensureTemplate(url, containerId, elementId) {
  if (document.getElementById(elementId)) return document.getElementById(elementId);
  const container = document.getElementById(containerId);
  if (!container) throw new Error(`Missing template mount: ${containerId}`);
  container.insertAdjacentHTML('beforeend', await fetchTemplate(url));
  return document.getElementById(elementId);
}
