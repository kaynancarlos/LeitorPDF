// Conversor de imagens em PDF (tudo no navegador, usando pdf-lib).
import { $, formatBytes, toast, downloadBlob, isImage } from './utils.js';

const QUALITY = {
  high:   { maxSide: 4000, jpeg: 0.95 },
  medium: { maxSide: 2400, jpeg: 0.82 },
  low:    { maxSide: 1500, jpeg: 0.65 },
};
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

export function createConverter({ openInReader }) {
  const el = {
    grid: $('#convGrid'),
    cards: $('#cards'),
    count: $('#convCount'),
    drop: $('#dropConv'),
    imgInput: $('#imgInput'),
    camInput: $('#camInput'),
    name: $('#optName'),
    size: $('#optSize'),
    orient: $('#optOrient'),
    fieldOrient: $('#fieldOrient'),
    margin: $('#optMargin'),
    quality: $('#optQuality'),
    make: $('#btnMake'),
    result: $('#result'),
    resultName: $('#resultName'),
    resultMeta: $('#resultMeta'),
    resShare: $('#btnResShare'),
  };

  let items = [];
  let uid = 0;
  let output = null; // { blob, name }
  let dragId = null;

  // ---------- adicionar / remover ----------
  function addFiles(fileList) {
    const files = [...fileList].filter(isImage);
    const skipped = fileList.length - files.length;
    if (!files.length) { toast('Escolha arquivos de imagem (JPG, PNG, WebP…).', 'error'); return; }
    if (skipped > 0) toast(`${skipped} arquivo(s) ignorado(s): não são imagens.`, 'info');
    files.forEach((file) => items.push({ id: ++uid, file, url: URL.createObjectURL(file), rot: 0 }));
    clearResult();
    render();
  }

  function remove(id) {
    const it = items.find((i) => i.id === id);
    if (it) URL.revokeObjectURL(it.url);
    items = items.filter((i) => i.id !== id);
    clearResult();
    render();
  }

  function move(id, dir) {
    const i = items.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    clearResult();
    render();
    $(`[data-id="${id}"] .card-move-${dir < 0 ? 'prev' : 'next'}`, el.cards)?.focus();
  }

  function clearAll() {
    items.forEach((i) => URL.revokeObjectURL(i.url));
    items = [];
    clearResult();
    render();
  }

  // ---------- interface ----------
  function render() {
    el.grid.hidden = items.length === 0;
    el.count.textContent = `${items.length} ${items.length === 1 ? 'imagem' : 'imagens'}`;
    el.cards.replaceChildren(...items.map(cardFor));
    el.fieldOrient.hidden = el.size.value === 'auto';
  }

  function btn(cls, label, icon, onClick, disabled = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `icon-btn icon-btn-sm ${cls}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.innerHTML = `<svg class="i" aria-hidden="true"><use href="#i-${icon}"/></svg>`;
    b.addEventListener('click', onClick);
    return b;
  }

  function cardFor(it, index) {
    const li = document.createElement('li');
    li.className = 'card';
    li.draggable = true;
    li.dataset.id = it.id;

    const thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    const img = document.createElement('img');
    img.src = it.url;
    img.alt = `Prévia de ${it.file.name}`;
    img.loading = 'lazy';
    img.draggable = false;
    img.style.transform = `rotate(${it.rot}deg)`;
    img.addEventListener('error', () => { thumb.classList.add('is-broken'); });
    const badge = document.createElement('span');
    badge.className = 'card-num';
    badge.textContent = index + 1;
    thumb.append(img, badge);

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = it.file.name;
    name.title = it.file.name;

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.append(
      btn('card-move-prev', 'Mover para trás', 'left', () => move(it.id, -1), index === 0),
      btn('card-rotate', 'Girar imagem', 'rotate', () => { it.rot = (it.rot + 90) % 360; clearResult(); render(); }),
      btn('card-move-next', 'Mover para frente', 'right', () => move(it.id, 1), index === items.length - 1),
      btn('card-remove', 'Remover imagem', 'trash', () => remove(it.id)),
    );

    li.append(thumb, name, actions);

    li.addEventListener('dragstart', (e) => { dragId = it.id; li.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(it.id)); });
    li.addEventListener('dragend', () => { dragId = null; li.classList.remove('is-dragging'); $$cards().forEach((c) => c.classList.remove('drop-before', 'drop-after')); });
    li.addEventListener('dragover', (e) => {
      if (dragId === null || dragId === it.id) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      li.classList.toggle('drop-after', after);
      li.classList.toggle('drop-before', !after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (e) => {
      if (dragId === null || dragId === it.id) return;
      e.preventDefault();
      e.stopPropagation();
      const after = li.classList.contains('drop-after');
      const from = items.findIndex((x) => x.id === dragId);
      const [moved] = items.splice(from, 1);
      let to = items.findIndex((x) => x.id === it.id);
      if (after) to += 1;
      items.splice(to, 0, moved);
      clearResult();
      render();
    });
    return li;
  }
  const $$cards = () => [...el.cards.children];

  function clearResult() {
    output = null;
    el.result.hidden = true;
  }

  // ---------- geração do PDF ----------
  async function loadBitmap(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
  }

  async function prepareImage(item, q) {
    const bmp = await loadBitmap(item.file);
    const w = bmp.width || bmp.naturalWidth;
    const h = bmp.height || bmp.naturalHeight;
    const k = Math.min(1, q.maxSide / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * k));
    const th = Math.max(1, Math.round(h * k));
    const swap = item.rot % 180 !== 0;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? th : tw;
    canvas.height = swap ? tw : th;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((item.rot * Math.PI) / 180);
    ctx.drawImage(bmp, -tw / 2, -th / 2, tw, th);
    const outW = canvas.width;
    const outH = canvas.height;
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', q.jpeg));
    bmp.close?.();
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error('Falha ao processar a imagem');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w: outW, h: outH };
  }

  function safeName(raw) {
    const n = raw.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
    return `${n || 'imagens'}.pdf`;
  }

  async function make() {
    if (!items.length) { toast('Adicione ao menos uma imagem.', 'error'); return; }
    const { PDFDocument } = window.PDFLib || {};
    if (!PDFDocument) { toast('Biblioteca de PDF ainda carregando. Tente novamente.', 'error'); return; }

    el.make.disabled = true;
    const label = el.make.innerHTML;
    const q = QUALITY[el.quality.value];
    const margin = Number(el.margin.value);
    const sizeMode = el.size.value;
    const orient = el.orient.value;

    try {
      const pdf = await PDFDocument.create();
      pdf.setCreator('Leitor PDF');
      pdf.setProducer('Leitor PDF');
      pdf.setCreationDate(new Date());

      for (let i = 0; i < items.length; i++) {
        el.make.textContent = `Processando ${i + 1} de ${items.length}…`;
        await new Promise((r) => setTimeout(r)); // deixa a interface respirar
        const img = await prepareImage(items[i], q);
        const embedded = await pdf.embedJpg(img.bytes);

        let pw; let ph; let dw; let dh;
        if (sizeMode === 'auto') {
          const fit = 842 / Math.max(img.w, img.h);
          dw = img.w * fit; dh = img.h * fit;
          pw = dw + margin * 2; ph = dh + margin * 2;
        } else {
          let [w, h] = PAGE_SIZES[sizeMode];
          const landscape = orient === 'landscape' || (orient === 'auto' && img.w > img.h);
          if (landscape) [w, h] = [h, w];
          pw = w; ph = h;
          const fit = Math.min((pw - margin * 2) / img.w, (ph - margin * 2) / img.h);
          dw = img.w * fit; dh = img.h * fit;
        }
        const page = pdf.addPage([pw, ph]);
        page.drawImage(embedded, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      }

      const name = safeName(el.name.value);
      pdf.setTitle(name.replace(/\.pdf$/i, ''));
      const bytes = await pdf.save();
      output = { blob: new Blob([bytes], { type: 'application/pdf' }), name };
      el.resultName.textContent = name;
      el.resultMeta.textContent = `${items.length} ${items.length === 1 ? 'página' : 'páginas'} • ${formatBytes(output.blob.size)}`;
      el.result.hidden = false;
      el.resShare.hidden = !(navigator.canShare && navigator.canShare({ files: [new File([output.blob], name, { type: 'application/pdf' })] }));
      el.result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      toast('PDF pronto!', 'success');
    } catch (err) {
      console.error(err);
      toast('Não foi possível gerar o PDF. Verifique se as imagens são válidas (HEIC pode não funcionar neste navegador).', 'error', 6000);
    } finally {
      el.make.disabled = false;
      el.make.innerHTML = label;
    }
  }

  async function share() {
    if (!output) return;
    try {
      await navigator.share({ files: [new File([output.blob], output.name, { type: 'application/pdf' })], title: output.name });
    } catch (err) {
      if (err?.name !== 'AbortError') toast('Não foi possível compartilhar.', 'error');
    }
  }

  // ---------- eventos ----------
  $('#btnAddImages').addEventListener('click', () => el.imgInput.click());
  $('#btnCamera').addEventListener('click', () => el.camInput.click());
  el.imgInput.addEventListener('change', () => { addFiles(el.imgInput.files); el.imgInput.value = ''; });
  el.camInput.addEventListener('change', () => { addFiles(el.camInput.files); el.camInput.value = ''; });
  $('#btnClear').addEventListener('click', clearAll);
  el.make.addEventListener('click', make);
  el.size.addEventListener('change', () => { el.fieldOrient.hidden = el.size.value === 'auto'; clearResult(); });
  [el.orient, el.margin, el.quality, el.name].forEach((c) => c.addEventListener('change', clearResult));
  $('#btnResDownload').addEventListener('click', () => output && downloadBlob(output.blob, output.name));
  $('#btnResOpen').addEventListener('click', () => output && openInReader(output.blob, output.name));
  el.resShare.addEventListener('click', share);

  // soltar arquivos na área do conversor
  ['dragenter', 'dragover'].forEach((ev) => el.drop.addEventListener(ev, (e) => { if (dragId !== null) return; e.preventDefault(); el.drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => el.drop.addEventListener(ev, () => el.drop.classList.remove('is-over')));

  render();
  return { addFiles };
}
