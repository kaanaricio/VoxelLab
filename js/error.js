import { notify } from './notify.js';

function normalizeError(error) {
  if (error instanceof Error) return error;
  return new Error(String(error || 'Unknown error'));
}

export async function softFail(promise, label) {
  try {
    return await promise;
  } catch (error) {
    const err = normalizeError(error);
    console.error(`[${label}]`, err);
    return null;
  }
}

export async function hardFail(promise, label) {
  try {
    return await promise;
  } catch (error) {
    const err = normalizeError(error);
    console.error(`[${label}]`, err);
    notify(`${label} failed`, { duration: 6000 });
    return null;
  }
}
