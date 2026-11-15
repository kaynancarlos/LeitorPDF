// Ponto de entrada: abas, tema, arrastar-e-soltar e atalhos globais.
import { $, $$, store, toast, isPdf, isImage } from './utils.js';
import { createViewer } from './viewer.js';
import { createConverter } from './converter.js';

const viewer = createViewer();
let currentView = 'reader';

const converter = createConverter({
  openInReader: (blob, name) => { showView('reader'); viewer.open(blob, name); },
});

// ---------- abas ----------
function showView(name, { updateHash = true } = {}) {
  currentView = name;
  $$('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $$('.view').forEach((v) => {
    const on = v.id === `view-${name}`;
    v.hidden = !on;
    v.classList.toggle('is-active', on);
  });
  if (updateHash) history.replaceState(null, '', name === 'converter' ? '#imagem-para-pdf' : location.pathname + location.search);
  if (name === 'reader') requestAnimationFrame(() => viewer.refit());
  document.title = name === 'converter'
    ? 'Imagem para PDF grátis, sem anúncios – Leitor PDF'
    : 'Leitor PDF online grátis, sem anúncios + Imagem para PDF';
}

$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
$('#btnGoConverter').addEventListener('click', () => showView('converter'));
if (location.hash === '#imagem-para-pdf') showView('converter', { updateHash: false });

// ---------- tema ----------
const root = document.documentElement;
const themeColor = document.querySelector('meta[name="theme-color"]');
function applyTheme(theme) {
  root.setAttribute('data-theme', theme);
  themeColor?.setAttribute('content', theme === 'dark' ? '#16161b' : '#ffffff');
}
function toggleTheme() {
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  store('theme', next);
}
applyTheme(root.getAttribute('data-theme'));
$('#btnTheme').addEventListener('click', toggleTheme);
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!store('theme')) applyTheme(e.matches ? 'dark' : 'light');
});

// ---------- ajuda ----------
const help = $('#helpDialog');
$('#btnHelp').addEventListener('click', () => help.showModal());

// ---------- arrastar e soltar (em qualquer lugar da página) ----------
const overlay = $('#dropOverlay');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; overlay.hidden = false; } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  overlay.hidden = true;
  if (!hasFiles(e)) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  const pdf = files.find(isPdf);
  const images = files.filter(isImage);
  if (currentView === 'converter' && images.length) { converter.addFiles(images); return; }
  if (pdf) { showView('reader'); viewer.open(pdf, pdf.name); return; }
  if (images.length) { showView('converter'); converter.addFiles(images); return; }
  toast('Solte um arquivo PDF ou imagens.', 'error');
});

// ---------- atalhos de teclado ----------
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'o' && currentView === 'reader') { e.preventDefault(); viewer.pickFile(); return; }
  if (currentView === 'reader' && viewer.hasDoc() && mod && ['f', 'g', 'p'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    viewer.handleKey(e);
    return;
  }
  if (typing || help.open || document.querySelector('dialog[open]')) return;
  if (e.key === '?') { help.showModal(); return; }
  if (!mod && e.key.toLowerCase() === 't') { toggleTheme(); return; }
  if (currentView === 'reader' && viewer.handleKey(e)) e.preventDefault();
});


// Abrir PDF direto do sistema ("Abrir com" → Leitor PDF). Chrome/Edge no computador.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const file = await params.files[0].getFile();
    showView('reader');
    viewer.open(file, file.name);
  });
}
