// Shared DICOM SR helpers (UID + timestamp).

export function uid() {
  const n = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, '');
  let dec = BigInt('0x' + n.slice(0, 32)).toString();
  return ('2.25.' + dec).slice(0, 64);
}

export function nowDicomDateTime() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
