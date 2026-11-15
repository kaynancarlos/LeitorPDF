// Leitor de PDF: renderização, zoom, navegação, miniaturas, busca.
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { $, clamp, debounce, store, toast, downloadBlob } from './utils.js';

const base = (p) => new URL(p, import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = base('../vendor/pdfjs/pdf.worker.min.mjs');

const DOC_OPTIONS = {
  cMapUrl: base('../vendor/pdfjs/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: base('../vendor/pdfjs/standard_fonts/'),
  wasmUrl: base('../vendor/pdfjs/wasm/'),
  iccUrl: base('../vendor/pdfjs/iccs/'),
  isEvalSupported: false,
  enableXfa: false,
};

const MIN_SCALE = 0.1;
const MAX_SCALE = 6;
const MAX_FIT_SCALE = 1.75; // limite do "ajustar à largura" em telas muito grandes
const MAX_CANVAS_PIXELS = 16e6;
const PAGE_GAP = 12;

export function createViewer() {
  // ---------- elementos ----------
  const el = {
    toolbar: $('#toolbar'),
    scroller: $('#scroller'),
    pages: $('#pages'),
    empty: $('#empty'),
    loading: $('#loading'),
    loadingText: $('#loadingText'),
    sidebar: $('#sidebar'),
    thumbs: $('#thumbs'),
    resizer: $('#resizer'),
    pageInput: $('#pageInput'),
    pageTotal: $('#pageTotal'),
    btnPrev: $('#btnPrev'),
    btnNext: $('#btnNext'),
    zoomSelect: $('#zoomSelect'),
    btnSidebar: $('#btnSidebar'),
    btnTool: $('#btnTool'),
    btnInvert: $('#btnInvert'),
    searchbar: $('#searchbar'),
    searchInput: $('#searchInput'),
    searchCount: $('#searchCount'),
    fileInput: $('#fileInput'),
    pwdDialog: $('#pwdDialog'),
    pwdInput: $('#pwdInput'),
    pwdMsg: $('#pwdMsg'),
  };

  // ---------- estado ----------
  const state = {
    doc: null,
    blob: null,
    name: '',
    token: 0,
    numPages: 0,
    pages: [],          // { num, el, canvas, text, key, pending, task }
    sizes: [],          // tamanho de cada página em escala 1, sem rotação extra
    tops: [],
    scale: 1,
    zoomMode: 'width',  // 'width' | 'page' | 'custom'
    rotation: 0,
    current: 1,
    tool: 'select',
    sidebarOpen: window.matchMedia('(min-width: 721px)').matches,
    sidebarWidth: Number(store('sidebarWidth')) || 200,
    search: { query: '', index: null, matches: [], at: -1, building: false },
  };
  const visible = new Set();
  const thumbVisible = new Set();
  let pageObserver = null;
  let thumbObserver = null;

  // ================= abrir arquivo =================
  async function open(blob, name = 'documento.pdf') {
    const token = ++state.token;
    showLoading('Abrindo PDF…');
    closeSearch();
    try {
      const data = new Uint8Array(await blob.arrayBuffer());
      const task = pdfjsLib.getDocument({ data, ...DOC_OPTIONS });
      task.onPassword = (update, reason) => askPassword(update, reason, task);
      const doc = await task.promise;
      if (token !== state.token) { doc.destroy(); return; }

      await teardown();
      state.doc = doc;
      state.blob = blob;
      state.name = name;
      state.numPages = doc.numPages;
      state.rotation = 0;
      state.zoomMode = 'width';
      state.search = { query: '', index: null, matches: [], at: -1, building: false };

      const first = await doc.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      state.sizes = Array.from({ length: doc.numPages }, () => ({ w: vp.width, h: vp.height }));

      buildPages();
      buildThumbs();
      el.empty.hidden = true;
      el.pages.hidden = false;
      el.toolbar.hidden = false;
      el.pageTotal.textContent = doc.numPages;
      applySidebarState();
      document.title = `${name.replace(/\.pdf$/i, '')} – Leitor PDF`;

      state.current = 1;
      state.scale = 1;
      layout();
      el.scroller.scrollTop = 0;
      applyFit('width');
      const saved = Number(store(lastKey())) || 1;
      if (saved > 1 && saved <= doc.numPages) goToPage(saved);
      updateNav();
      el.scroller.focus({ preventScroll: true });
      loadAllSizes(token);
    } catch (err) {
      if (token !== state.token) return;
      console.error(err);
      if (err?.name === 'PasswordException') toast('Senha incorreta ou não informada.', 'error');
      else if (err?.name === 'InvalidPDFException') toast('Este arquivo não é um PDF válido.', 'error');
      else toast('Não foi possível abrir este PDF.', 'error');
    } finally {
      if (token === state.token) hideLoading();
    }
  }

  function lastKey() {
    return `last:${state.name}:${state.blob?.size ?? 0}`;
  }

  async function teardown() {
    visible.clear();
    thumbVisible.clear();
    pageObserver?.disconnect();
    thumbObserver?.disconnect();
    state.pages.forEach((p) => p.task?.cancel());
    el.pages.replaceChildren();
    el.thumbs.replaceChildren();
    state.pages = [];
    if (state.doc) { try { await state.doc.destroy(); } catch { /* ok */ } }
    state.doc = null;
  }

  // senha
  function askPassword(update, reason, task) {
    el.pwdMsg.textContent = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? 'Senha incorreta. Tente novamente.'
      : 'Digite a senha para abrir este documento.';
    el.pwdInput.value = '';
    const onClose = () => {
      el.pwdDialog.removeEventListener('close', onClose);
      if (el.pwdDialog.returnValue === 'ok' && el.pwdInput.value) update(el.pwdInput.value);
      else task.destroy();
    };
    el.pwdDialog.addEventListener('close', onClose);
    el.pwdDialog.returnValue = '';
    el.pwdDialog.showModal();
    el.pwdInput.focus();
  }

  // tamanhos reais das demais páginas, em segundo plano
  async function loadAllSizes(token) {
    const doc = state.doc;
    let dirty = false;
    for (let i = 2; i <= doc.numPages; i++) {
      if (token !== state.token) return;
      try {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const s = state.sizes[i - 1];
        if (Math.abs(s.w - vp.width) > 0.5 || Math.abs(s.h - vp.height) > 0.5) {
          state.sizes[i - 1] = { w: vp.width, h: vp.height };
          dirty = true;
        }
      } catch { /* página com problema: mantém tamanho padrão */ }
      if (dirty && (i % 40 === 0 || i === doc.numPages)) { relayoutKeepingPosition(); dirty = false; }
    }
    if (dirty) relayoutKeepingPosition();
  }

  function relayoutKeepingPosition() {
    const cur = state.current;
    const off = el.scroller.scrollTop - (state.tops[cur - 1] ?? 0);
    layout();
    el.scroller.scrollTop = (state.tops[cur - 1] ?? 0) + off;
    if (state.zoomMode !== 'custom') refit();
  }

  // ================= páginas =================
  function buildPages() {
    state.pages = [];
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= state.numPages; i++) {
      const pageEl = document.createElement('div');
      pageEl.className = 'page';
      pageEl.dataset.page = i;
      pageEl.setAttribute('role', 'img');
      pageEl.setAttribute('aria-label', `Página ${i}`);
      const canvas = document.createElement('canvas');
      const text = document.createElement('div');
      text.className = 'textLayer';
      pageEl.append(canvas, text);
      frag.append(pageEl);
      state.pages.push({ num: i, el: pageEl, canvas, text, key: null, pending: null, task: null });
    }
    el.pages.append(frag);

    pageObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = state.pages[Number(e.target.dataset.page) - 1];
        if (!p) continue;
        if (e.isIntersecting) { visible.add(p); renderPage(p); }
        else { visible.delete(p); unrenderPage(p); }
      }
    }, { root: el.scroller, rootMargin: '150% 0px' });
    state.pages.forEach((p) => pageObserver.observe(p.el));
  }

  function pageDims(i) {
    const s = state.sizes[i];
    const swap = state.rotation % 180 !== 0;
    return { w: (swap ? s.h : s.w) * state.scale, h: (swap ? s.w : s.h) * state.scale };
  }

  function layout() {
    state.pages.forEach((p, i) => {
      const d = pageDims(i);
      p.el.style.width = `${d.w}px`;
      p.el.style.height = `${d.h}px`;
      p.el.style.setProperty('--total-scale-factor', state.scale);
      p.el.style.setProperty('--scale-factor', state.scale);
    });
    state.tops = state.pages.map((p) => p.el.offsetTop);
    state.thumbItems?.forEach((t, i) => {
      const s = state.sizes[i];
      const swap = state.rotation % 180 !== 0;
      t.box.style.aspectRatio = swap ? `${s.h} / ${s.w}` : `${s.w} / ${s.h}`;
    });
  }

  function renderPage(p) {
    const dpr = outputScale();
    const key = `${state.scale.toFixed(4)}|${state.rotation}|${dpr.toFixed(2)}`;
    if (p.key === key) return Promise.resolve();
    if (p.pending === key) return p.promise;
    p.task?.cancel();
    p.pending = key;
    const doc = state.doc;
    const token = state.token;
    p.promise = (async () => {
      try {
        const page = await doc.getPage(p.num);
        if (p.pending !== key || token !== state.token) return;
        const rotation = (page.rotate + state.rotation) % 360;
        const viewport = page.getViewport({ scale: state.scale, rotation });
        const ratio = fitPixelRatio(viewport, dpr);

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        const ctx = canvas.getContext('2d', { alpha: false });
        const task = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
          background: '#ffffff',
        });
        p.task = task;
        await task.promise;
        if (p.pending !== key || token !== state.token) return;

        const text = document.createElement('div');
        text.className = 'textLayer';
        const tl = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent(),
          container: text,
          viewport,
        });
        await tl.render();
        if (p.pending !== key || token !== state.token) return;

        p.el.replaceChild(canvas, p.canvas);
        p.el.replaceChild(text, p.text);
        p.canvas = canvas;
        p.text = text;
        p.key = key;
        applyHighlights(p);
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') console.warn('Falha ao renderizar página', p.num, err);
      } finally {
        if (p.pending === key) p.pending = null;
      }
    })();
    return p.promise;
  }

  function unrenderPage(p) {
    p.task?.cancel();
    p.pending = null;
    p.key = null;
    p.canvas.width = p.canvas.height = 0;
    p.text.replaceChildren();
  }

  const outputScale = () => Math.min(window.devicePixelRatio || 1, 2.5);
  function fitPixelRatio(viewport, dpr) {
    const px = viewport.width * viewport.height * dpr * dpr;
    return px > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)) : dpr;
  }

  const renderVisible = debounce(() => visible.forEach((p) => renderPage(p)), 90);

  // ================= miniaturas =================
  function buildThumbs() {
    state.thumbItems = [];
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= state.numPages; i++) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'thumb';
      item.dataset.page = i;
      item.setAttribute('aria-label', `Ir para a página ${i}`);
      const box = document.createElement('span');
      box.className = 'thumb-box';
      const canvas = document.createElement('canvas');
      box.append(canvas);
      const label = document.createElement('span');
      label.className = 'thumb-label';
      label.textContent = i;
      item.append(box, label);
      frag.append(item);
      state.thumbItems.push({ item, box, canvas, key: null });
    }
    el.thumbs.append(frag);

    thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const idx = Number(e.target.dataset.page) - 1;
        if (e.isIntersecting) { thumbVisible.add(idx); renderThumb(idx); }
        else thumbVisible.delete(idx);
      }
    }, { root: el.sidebar, rootMargin: '300px 0px' });
    state.thumbItems.forEach((t) => thumbObserver.observe(t.item));
  }

  async function renderThumb(idx) {
    const t = state.thumbItems[idx];
    if (!t) return;
    const key = String(state.rotation);
    if (t.key === key) return;
    t.key = key;
    const doc = state.doc;
    const token = state.token;
    try {
      const page = await doc.getPage(idx + 1);
      if (token !== state.token) return;
      const rotation = (page.rotate + state.rotation) % 360;
      const v1 = page.getViewport({ scale: 1, rotation });
      const targetW = 240;
      const viewport = page.getViewport({ scale: targetW / v1.width, rotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d', { alpha: false }), viewport, background: '#ffffff' }).promise;
      if (token !== state.token || t.key !== key) return;
      t.box.replaceChild(canvas, t.canvas);
      t.canvas = canvas;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') t.key = null;
    }
  }

  function applySidebarState() {
    const open = state.sidebarOpen && !!state.doc;
    el.sidebar.hidden = !open;
    el.resizer.hidden = !open;
    el.btnSidebar.setAttribute('aria-pressed', String(state.sidebarOpen));
    el.sidebar.style.width = `${state.sidebarWidth}px`;
    if (open) revealThumb(state.current);
  }

  function revealThumb(n) {
    const t = state.thumbItems?.[n - 1];
    if (!t || el.sidebar.hidden) return;
    const sb = el.sidebar;
    const top = t.item.offsetTop;
    const bottom = top + t.item.offsetHeight;
    if (top < sb.scrollTop + 8 || bottom > sb.scrollTop + sb.clientHeight - 8) {
      sb.scrollTop = top - (sb.clientHeight - t.item.offsetHeight) / 2;
    }
  }

  // ================= zoom e rotação =================
  function fitScale(mode) {
    const s = state.sizes[state.current - 1] || state.sizes[0];
    const swap = state.rotation % 180 !== 0;
    const w = swap ? s.h : s.w;
    const h = swap ? s.w : s.h;
    const availW = el.scroller.clientWidth - 32;
    const availH = el.scroller.clientHeight - 32;
    const byWidth = availW / w;
    const value = mode === 'page' ? Math.min(byWidth, availH / h) : Math.min(byWidth, MAX_FIT_SCALE);
    return clamp(value, MIN_SCALE, MAX_SCALE);
  }

  function pageIndexAt(y) {
    const tops = state.tops;
    let lo = 0; let hi = tops.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }

  // Muda o zoom mantendo o mesmo ponto do documento sob o "anchor" (centro da tela por padrão).
  function setScale(scale, { mode = 'custom', anchor } = {}) {
    const sc = el.scroller;
    const ax = anchor?.x ?? sc.clientWidth / 2;
    const ay = anchor?.y ?? sc.clientHeight / 2;
    const fx = sc.scrollWidth ? (sc.scrollLeft + ax) / sc.scrollWidth : 0;
    const y = sc.scrollTop + ay;
    const idx = pageIndexAt(y);
    const oldH = state.pages[idx]?.el.offsetHeight || 1;
    const frac = (y - (state.tops[idx] ?? 0)) / oldH;

    state.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    state.zoomMode = mode;
    layout();
    sc.scrollLeft = fx * sc.scrollWidth - ax;
    sc.scrollTop = (state.tops[idx] ?? 0) + frac * (state.pages[idx]?.el.offsetHeight || 0) - ay;
    renderVisible();
    updateZoomUI();
    onScroll();
  }

  function applyFit(mode) {
    // 1ª passada define o tamanho; a 2ª corrige se uma barra de rolagem apareceu
    const top = { y: 0 };
    setScale(fitScale(mode), { mode, anchor: top });
    setScale(fitScale(mode), { mode, anchor: top });
    if (mode === 'page') goToPage(state.current);
  }

  const refit = () => {
    if (!state.doc || state.zoomMode === 'custom') return;
    const cur = state.current;
    setScale(fitScale(state.zoomMode), { mode: state.zoomMode, anchor: { y: 0 } });
    goToPage(cur);
  };

  function zoomBy(factor, anchor) {
    setScale(state.scale * factor, { anchor });
  }

  function stepZoom(dir) {
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
    const cur = state.scale;
    const next = dir > 0 ? steps.find((s) => s > cur + 0.01) : [...steps].reverse().find((s) => s < cur - 0.01);
    setScale(next ?? cur);
  }

  function updateZoomUI() {
    const sel = el.zoomSelect;
    sel.querySelector('[data-custom]')?.remove();
    if (state.zoomMode === 'width' || state.zoomMode === 'page') {
      sel.value = state.zoomMode;
      return;
    }
    const match = [...sel.options].find((o) => !isNaN(Number(o.value)) && Math.abs(Number(o.value) - state.scale) < 0.005);
    if (match) { sel.value = match.value; return; }
    const opt = document.createElement('option');
    opt.dataset.custom = '1';
    opt.value = String(state.scale);
    opt.textContent = `${Math.round(state.scale * 100)}%`;
    sel.prepend(opt);
    sel.value = opt.value;
  }

  function rotate() {
    if (!state.doc) return;
    const cur = state.current;
    state.rotation = (state.rotation + 90) % 360;
    state.thumbItems.forEach((t) => { t.key = null; });
    thumbVisible.forEach((i) => renderThumb(i));
    if (state.zoomMode === 'custom') { layout(); renderVisible(); } else { setScale(fitScale(state.zoomMode), { mode: state.zoomMode, anchor: { y: 0 } }); }
    goToPage(cur);
  }

  // ================= navegação =================
  function goToPage(n) {
    if (!state.doc) return;
    n = clamp(Math.round(n) || 1, 1, state.numPages);
    el.scroller.scrollTop = (state.tops[n - 1] ?? 0) - PAGE_GAP;
    setCurrent(n);
  }

  function setCurrent(n) {
    state.current = n;
    if (document.activeElement !== el.pageInput) el.pageInput.value = n;
    state.thumbItems?.forEach((t, i) => t.item.classList.toggle('is-active', i === n - 1));
    revealThumb(n);
    updateNav();
    saveLast();
  }

  const saveLast = debounce(() => { if (state.doc) store(lastKey(), state.current); }, 400);

  function updateNav() {
    el.btnPrev.disabled = !state.doc || state.current <= 1;
    el.btnNext.disabled = !state.doc || state.current >= state.numPages;
  }

  let scrollTicking = false;
  function onScroll() {
    if (scrollTicking || !state.doc) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      const sc = el.scroller;
      const tops = state.tops;
      let n;
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) n = state.numPages;
      else {
        const y = sc.scrollTop + sc.clientHeight * 0.4;
        let lo = 0; let hi = tops.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
        n = lo + 1;
      }
      if (n !== state.current) setCurrent(n);
    });
  }

  // ================= ferramenta mão =================
  function setTool(tool) {
    state.tool = tool;
    el.scroller.classList.toggle('tool-hand', tool === 'hand');
    el.btnTool.setAttribute('aria-pressed', String(tool === 'hand'));
  }

  function initPan() {
    let pan = null;
    el.scroller.addEventListener('pointerdown', (e) => {
      if (state.tool !== 'hand' || e.button !== 0 || e.pointerType === 'touch') return;
      pan = { x: e.clientX, y: e.clientY, l: el.scroller.scrollLeft, t: el.scroller.scrollTop };
      el.scroller.setPointerCapture(e.pointerId);
      el.scroller.classList.add('is-panning');
    });
    el.scroller.addEventListener('pointermove', (e) => {
      if (!pan) return;
      el.scroller.scrollLeft = pan.l - (e.clientX - pan.x);
      el.scroller.scrollTop = pan.t - (e.clientY - pan.y);
    });
    const end = () => { pan = null; el.scroller.classList.remove('is-panning'); };
    el.scroller.addEventListener('pointerup', end);
    el.scroller.addEventListener('pointercancel', end);
  }

  // zoom por pinça (celular) e Ctrl+scroll (mouse/trackpad)
  function initZoomGestures() {
    el.scroller.addEventListener('wheel', (e) => {
      if (!state.doc || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.scroller.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, { passive: false });

    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    el.scroller.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && state.doc) pinch = { d: dist(e.touches), s: state.scale };
    }, { passive: true });
    el.scroller.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const rect = el.scroller.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      setScale(pinch.s * (dist(e.touches) / pinch.d), { anchor: { x: cx, y: cy } });
    }, { passive: false });
    const endPinch = (e) => { if (e.touches.length < 2) pinch = null; };
    el.scroller.addEventListener('touchend', endPinch, { passive: true });
    el.scroller.addEventListener('touchcancel', endPinch, { passive: true });
  }

  // ================= lateral redimensionável =================
  function initResizer() {
    const min = 140; const max = 480;
    const setW = (w) => {
      state.sidebarWidth = clamp(Math.round(w), min, max);
      el.sidebar.style.width = `${state.sidebarWidth}px`;
    };
    let drag = null;
    el.resizer.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, w: state.sidebarWidth };
      el.resizer.setPointerCapture(e.pointerId);
      document.body.classList.add('is-resizing');
    });
    el.resizer.addEventListener('pointermove', (e) => { if (drag) setW(drag.w + e.clientX - drag.x); });
    const end = () => {
      if (!drag) return;
      drag = null;
      document.body.classList.remove('is-resizing');
      store('sidebarWidth', state.sidebarWidth);
      refit();
    };
    el.resizer.addEventListener('pointerup', end);
    el.resizer.addEventListener('pointercancel', end);
    el.resizer.addEventListener('dblclick', () => { setW(200); store('sidebarWidth', 200); refit(); });
    el.resizer.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { setW(state.sidebarWidth - 20); e.preventDefault(); }
      if (e.key === 'ArrowRight') { setW(state.sidebarWidth + 20); e.preventDefault(); }
      store('sidebarWidth', state.sidebarWidth);
    });
  }

  // ================= busca =================
  function openSearch() {
    if (!state.doc) return;
    el.searchbar.hidden = false;
    el.searchInput.focus();
    el.searchInput.select();
  }

  function closeSearch() {
    el.searchbar.hidden = true;
    el.searchInput.value = '';
    if (state.search) {
      state.search.query = '';
      state.search.matches = [];
      state.search.at = -1;
    }
    el.searchCount.textContent = '';
    state.pages.forEach(clearHighlights);
  }

  async function buildIndex() {
    const s = state.search;
    if (s.index) return s.index;
    if (s.building) return null;
    s.building = true;
    const token = state.token;
    const doc = state.doc;
    const index = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        if (token !== state.token) return null;
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        index.push(tc.items.map((it) => it.str).filter((str) => str.trim()).map((str) => str.toLowerCase()));
        if (i % 10 === 0) el.searchCount.textContent = `Indexando ${Math.round((i / doc.numPages) * 100)}%`;
      }
      s.index = index;
      return index;
    } finally {
      s.building = false;
    }
  }

  const norm = (str) => str.toLowerCase();

  async function runSearch() {
    const q = norm(el.searchInput.value.trim());
    const s = state.search;
    s.query = q;
    state.pages.forEach(clearHighlights);
    if (!q) { s.matches = []; s.at = -1; el.searchCount.textContent = ''; return; }
    const index = await buildIndex();
    if (!index || s.query !== q) return;
    const matches = [];
    index.forEach((items, pi) => items.forEach((str, ii) => { if (str.includes(q)) matches.push({ page: pi + 1, item: ii }); }));
    s.matches = matches;
    s.at = matches.length ? Math.max(0, matches.findIndex((m) => m.page >= state.current)) : -1;
    state.pages.forEach(applyHighlights);
    updateSearchCount();
    if (matches.length) focusMatch();
  }

  function updateSearchCount() {
    const s = state.search;
    el.searchCount.textContent = !s.query ? '' : s.matches.length ? `${s.at + 1} de ${s.matches.length}` : 'Nenhum resultado';
  }

  function stepMatch(dir) {
    const s = state.search;
    if (!s.matches.length) return;
    s.at = (s.at + dir + s.matches.length) % s.matches.length;
    updateSearchCount();
    focusMatch();
  }

  async function focusMatch() {
    const s = state.search;
    const m = s.matches[s.at];
    if (!m) return;
    const p = state.pages[m.page - 1];
    goToPage(m.page);
    await renderPage(p);
    state.pages.forEach(applyHighlights);
    p.text.querySelector('.hl.current')?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }

  function textSpans(p) {
    return [...p.text.querySelectorAll(':scope > span, :scope .markedContent > span')].filter((sp) => sp.textContent.trim());
  }

  function clearHighlights(p) {
    p.text.querySelectorAll('.hl').forEach((sp) => sp.classList.remove('hl', 'current'));
  }

  function applyHighlights(p) {
    const s = state.search;
    if (!s.query || !s.matches.length) return;
    const mine = s.matches.map((m, i) => ({ ...m, i })).filter((m) => m.page === p.num);
    if (!mine.length || !p.text.childElementCount) return;
    const spans = textSpans(p);
    mine.forEach((m) => {
      const sp = spans[m.item];
      if (!sp) return;
      sp.classList.add('hl');
      if (m.i === s.at) sp.classList.add('current');
    });
  }

  // ================= ações =================
  function download() {
    if (!state.blob) return;
    downloadBlob(state.blob, /\.pdf$/i.test(state.name) ? state.name : `${state.name}.pdf`);
  }

  function print() {
    if (!state.blob) return;
    const url = URL.createObjectURL(state.blob);
    const frame = document.createElement('iframe');
    frame.className = 'print-frame';
    frame.src = url;
    frame.onload = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch { window.open(url, '_blank'); }
      setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60000);
    };
    document.body.append(frame);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    applySidebarState();
    if (state.doc) setTimeout(refit, 0);
  }

  function showLoading(msg) { el.loadingText.textContent = msg; el.loading.hidden = false; }
  function hideLoading() { el.loading.hidden = true; }

  function commitPageInput() {
    const n = parseInt(el.pageInput.value, 10);
    if (!n) { el.pageInput.value = state.current; return; }
    goToPage(n);
    el.pageInput.value = clamp(n, 1, state.numPages);
  }

  // ================= eventos =================
  function bind() {
    el.scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', debounce(refit, 150));

    $('#btnPick').addEventListener('click', () => el.fileInput.click());
    $('#btnOpen').addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => {
      const f = el.fileInput.files[0];
      if (f) open(f, f.name);
      el.fileInput.value = '';
    });

    el.btnPrev.addEventListener('click', () => goToPage(state.current - 1));
    el.btnNext.addEventListener('click', () => goToPage(state.current + 1));
    el.pageInput.addEventListener('input', () => { el.pageInput.value = el.pageInput.value.replace(/\D/g, ''); });
    el.pageInput.addEventListener('focus', () => el.pageInput.select());
    el.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commitPageInput(); el.pageInput.blur(); el.scroller.focus({ preventScroll: true }); }
      if (e.key === 'Escape') { el.pageInput.value = state.current; el.pageInput.blur(); }
    });
    el.pageInput.addEventListener('blur', () => { el.pageInput.value = state.current; });

    $('#btnZoomIn').addEventListener('click', () => stepZoom(1));
    $('#btnZoomOut').addEventListener('click', () => stepZoom(-1));
    el.zoomSelect.addEventListener('change', () => {
      const v = el.zoomSelect.value;
      if (v === 'width' || v === 'page') applyFit(v); else setScale(Number(v));
      el.scroller.focus({ preventScroll: true });
    });

    $('#btnRotate').addEventListener('click', rotate);
    el.btnTool.addEventListener('click', () => setTool(state.tool === 'hand' ? 'select' : 'hand'));
    el.btnSidebar.addEventListener('click', toggleSidebar);
    $('#btnSearch').addEventListener('click', () => (el.searchbar.hidden ? openSearch() : closeSearch()));
    el.btnInvert.addEventListener('click', () => setInvert(!isInverted()));
    $('#btnDownload').addEventListener('click', download);
    $('#btnPrint').addEventListener('click', print);
    $('#btnFullscreen').addEventListener('click', toggleFullscreen);

    el.thumbs.addEventListener('click', (e) => {
      const t = e.target.closest('.thumb');
      if (!t) return;
      goToPage(Number(t.dataset.page));
      if (window.matchMedia('(max-width: 720px)').matches) toggleSidebar(); // no celular a lateral fica por cima
    });

    el.searchInput.addEventListener('input', debounce(runSearch, 220));
    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (state.search.query !== norm(el.searchInput.value.trim())) runSearch(); else stepMatch(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') closeSearch();
    });
    $('#searchNext').addEventListener('click', () => stepMatch(1));
    $('#searchPrev').addEventListener('click', () => stepMatch(-1));
    $('#searchClose').addEventListener('click', closeSearch);

    initPan();
    initZoomGestures();
    initResizer();
    setInvert(isInverted());
  }

  const isInverted = () => document.documentElement.getAttribute('data-pages') === 'dark';
  function setInvert(on) {
    if (on) document.documentElement.setAttribute('data-pages', 'dark');
    else document.documentElement.removeAttribute('data-pages');
    el.btnInvert.setAttribute('aria-pressed', String(on));
    store('invert', on ? '1' : '0');
  }

  function handleKey(e) {
    if (!state.doc) return false;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (mod && key.toLowerCase() === 'f') { openSearch(); return true; }
    if (mod && key.toLowerCase() === 'g') { el.pageInput.focus(); return true; }
    if (mod && key.toLowerCase() === 'p') { print(); return true; }
    if (mod || e.altKey) return false;
    switch (key) {
      case 'ArrowLeft': case 'PageUp': if (key === 'ArrowLeft' || e.shiftKey) { goToPage(state.current - 1); return true; } return false;
      case 'ArrowRight': case 'PageDown': if (key === 'ArrowRight' || e.shiftKey) { goToPage(state.current + 1); return true; } return false;
      case 'Home': goToPage(1); return true;
      case 'End': goToPage(state.numPages); return true;
      case '+': case '=': stepZoom(1); return true;
      case '-': case '_': stepZoom(-1); return true;
      case '0': applyFit('width'); return true;
      case 'r': case 'R': rotate(); return true;
      case 'h': case 'H': setTool(state.tool === 'hand' ? 'select' : 'hand'); return true;
      case 'f': case 'F': toggleFullscreen(); return true;
      case 'Escape': if (!el.searchbar.hidden) { closeSearch(); return true; } return false;
      default: return false;
    }
  }

  bind();
  return {
    open,
    pickFile: () => el.fileInput.click(),
    handleKey,
    openSearch,
    refit,
    hasDoc: () => !!state.doc,
  };
}
