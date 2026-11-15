// Funções utilitárias compartilhadas.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function debounce(fn, ms = 100) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1).replace('.', ',')} ${units[i]}`;
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`lpdf:${key}`);
    if (value === null) localStorage.removeItem(`lpdf:${key}`);
    else localStorage.setItem(`lpdf:${key}`, String(value));
  } catch { /* armazenamento indisponível */ }
  return null;
}

export function toast(message, type = 'info', ms = 3800) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const isPdf = (file) =>
  file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));

export const isImage = (file) =>
  file && (/^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name || ''));
