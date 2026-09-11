/* geo-dude — UI and state. Image work lives in image.js (window.GeoImage). */
'use strict';

const IMG = window.GeoImage;
const $ = (id) => document.getElementById(id);

const fmtMB = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB'
                                  : Math.max(1, Math.round(b / 1024)) + ' KB';

/* Let the browser paint before continuing a long loop. */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/* ---------- state --------------------------------------------------------- */

const photos = [];   // { key, file, format, thumb, note }
let societies = [];
let society = null;
let busy = false;

/* ---------- step 1 : photos ---------------------------------------------- */

const drop = $('drop'), fileInput = $('file'), grid = $('grid');

let addQueue = Promise.resolve();

/* Picks are serialised: a second pick arriving while the first is still
   decoding thumbnails would otherwise interleave, and the slower one would
   overwrite the other's status note. */
function addFiles(fileList) {
  const incoming = Array.from(fileList);
  if (!incoming.length) return addQueue;
  addQueue = addQueue.then(() => addFilesNow(incoming)).catch((err) => {
    console.error('geo-dude: adding files failed', err);
  });
  return addQueue;
}

async function addFilesNow(incoming) {

  let added = 0, dupes = 0;
  const rejected = [];

  setNote($('pickNote'), `Reading ${incoming.length} file${incoming.length === 1 ? '' : 's'}…`);

  for (const file of incoming) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (photos.some((p) => p.key === key)) { dupes++; continue; }

    const format = await IMG.sniffFormat(file);
    if (format === 'gif' || format === 'unknown' || format === 'avif') {
      rejected.push(file.name);
      continue;
    }
    const entry = { key, file, format, thumb: null, note: null };
    photos.push(entry);
    added++;
    renderGrid();                 // show the tile immediately
    await nextFrame();            // …then decode its preview without blocking
    entry.thumb = await IMG.makeThumb(file, format);
    renderGrid();
  }

  const bits = [];
  if (added) bits.push(`Added ${added} photo${added === 1 ? '' : 's'}.`);
  if (dupes) bits.push(`${dupes} already in the list.`);
  if (rejected.length) {
    bits.push(`Can't use ${rejected.length} file${rejected.length === 1 ? '' : 's'} ` +
              `(${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? '…' : ''}) — ` +
              `JPEG, HEIC, PNG and WebP only.`);
  }
  setNote($('pickNote'), bits.join(' '), rejected.length ? 'warn' : '');
  renderGrid();
}

const BADGE = { heic: 'HEIC', png: 'PNG', webp: 'WEBP' };

function renderGrid() {
  grid.textContent = '';
  for (const p of photos) {
    const li = document.createElement('li');
    if (p.thumb) {
      const img = document.createElement('img');
      img.src = p.thumb; img.alt = p.file.name;
      li.append(img);
    } else {
      li.classList.add('loading');
    }
    if (BADGE[p.format]) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = BADGE[p.format];
      b.title = `${BADGE[p.format]} — will be converted to JPEG`;
      li.append(b);
    }
    if (p.note) {
      const n = document.createElement('span');
      n.className = 'tag-note';
      n.textContent = p.note;
      li.append(n);
    }
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.textContent = '×';
    x.setAttribute('aria-label', `Remove ${p.file.name}`);
    x.addEventListener('click', () => removePhoto(p.key));
    li.append(x);
    grid.append(li);
  }
  const n = photos.length;
  $('count').textContent = n;
  $('countWord').textContent = n === 1 ? 'photo' : 'photos';
  const total = photos.reduce((s, p) => s + p.file.size, 0);
  $('totalSize').textContent = n ? ` · ${fmtMB(total)}` : '';
  $('gridHead').hidden = n === 0;
  refreshGo();
}

function removePhoto(key) {
  const i = photos.findIndex((p) => p.key === key);
  if (i < 0) return;
  if (photos[i].thumb) URL.revokeObjectURL(photos[i].thumb);
  photos.splice(i, 1);
  renderGrid();
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => {
  // fileInput.files is a LIVE FileList — copy it before clearing the input,
  // or resetting value wipes the very list we are about to read.
  const picked = Array.from(fileInput.files);
  fileInput.value = '';        // reset so re-picking the same file re-fires
  addFiles(picked);
});
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
$('clear').addEventListener('click', () => {
  photos.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb));
  photos.length = 0;
  setNote($('pickNote'), '');
  renderGrid();
});

/* ---------- step 2 : society combobox ------------------------------------ */

const socInput = $('soc'), socList = $('socList'), socClear = $('socClear');
let matches = [], active = -1;

fetch('coords.json')
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then((data) => {
    societies = data.filter((s) =>
      s && s.society_name && Number.isFinite(+s.latitude) && Number.isFinite(+s.longitude));
    setNote($('socNote'), `${societies.length} societies loaded.`);
  })
  .catch((err) => {
    setNote($('socNote'),
      `Could not load coords.json (${err.message}). This page must be served over http:// — ` +
      `see the README.`, 'warn');
  });

function closeList() {
  socList.hidden = true;
  socInput.setAttribute('aria-expanded', 'false');
  socInput.removeAttribute('aria-activedescendant');
  active = -1;
}

function openList(q) {
  const needle = q.trim().toLowerCase();
  matches = (needle
    ? societies.filter((s) => s.society_name.toLowerCase().includes(needle))
    : societies
  ).slice(0, 60);

  socList.textContent = '';
  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No society matches that.';
    socList.append(li);
  } else {
    matches.forEach((s, i) => {
      const li = document.createElement('li');
      li.id = `soc-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.textContent = s.society_name;
      const co = document.createElement('span');
      co.className = 'co';
      co.textContent = `${(+s.latitude).toFixed(5)}, ${(+s.longitude).toFixed(5)}`;
      li.append(co);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      socList.append(li);
    });
  }
  socList.hidden = false;
  socInput.setAttribute('aria-expanded', 'true');
  active = -1;
}

function highlight(next) {
  if (!matches.length) return;
  active = (next + matches.length) % matches.length;
  Array.from(socList.children).forEach((li, i) => {
    const on = i === active;
    li.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) {
      li.scrollIntoView({ block: 'nearest' });
      socInput.setAttribute('aria-activedescendant', li.id);
    }
  });
}

function choose(i) {
  society = matches[i];
  socInput.value = society.society_name;
  socClear.hidden = false;
  $('pickedName').textContent = society.society_name;
  $('pickedCoords').textContent =
    `${(+society.latitude).toFixed(6)}, ${(+society.longitude).toFixed(6)}`;
  $('picked').hidden = false;
  setNote($('socNote'), '');
  closeList();
  refreshGo();
}

socInput.addEventListener('input', () => {
  society = null;
  $('picked').hidden = true;
  socClear.hidden = socInput.value === '';
  openList(socInput.value);
  refreshGo();
});
socInput.addEventListener('focus', () => { if (!society) openList(socInput.value); });
socInput.addEventListener('blur', () => setTimeout(closeList, 120));
socInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (socList.hidden) openList(socInput.value); else highlight(active + 1);
    if (active === -1) highlight(0);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault(); highlight(active - 1);
  } else if (e.key === 'Enter') {
    if (!socList.hidden && active >= 0) { e.preventDefault(); choose(active); }
  } else if (e.key === 'Escape') {
    closeList();
  }
});
socClear.addEventListener('click', () => {
  society = null; socInput.value = ''; socClear.hidden = true;
  $('picked').hidden = true; closeList(); socInput.focus(); refreshGo();
});

/* ---------- step 3 : tag & zip ------------------------------------------- */

const go = $('go'), bar = $('bar'), barFill = $('barFill');

function setNote(el, msg, cls) {
  el.textContent = msg;
  el.className = 'note' + (cls ? ' ' + cls : '');
}

function progress(done, total, label) {
  bar.hidden = false;
  barFill.style.width = `${Math.round((done / total) * 100)}%`;
  bar.setAttribute('aria-valuenow', String(Math.round((done / total) * 100)));
  setNote($('goNote'), label);
}

function refreshGo(keepNote) {
  if (busy) return;
  const ready = photos.length > 0 && society !== null;
  go.disabled = !ready;
  if (keepNote) return;
  if (ready) {
    setNote($('goNote'),
      `Ready: ${photos.length} photo${photos.length === 1 ? '' : 's'} → ${society.society_name}.`);
  } else if (!photos.length && !society) {
    setNote($('goNote'), 'Pick at least one photo and a society first.');
  } else if (!photos.length) {
    setNote($('goNote'), 'Now choose at least one photo.');
  } else {
    setNote($('goNote'), 'Now choose a society.');
  }
}

go.addEventListener('click', async () => {
  if (busy || !photos.length || !society) return;
  busy = true;
  go.disabled = true;
  $('fails').hidden = true;
  $('fails').textContent = '';
  photos.forEach((p) => { p.note = null; });

  const lat = +society.latitude, lng = +society.longitude;
  const zip = new JSZip();
  const used = new Map();
  const failed = [];
  let done = 0, inTotal = 0, outTotal = 0;

  // Run a few photos concurrently so a decode overlaps the worker encodes.
  // Results are collected by index, then zipped in the original order.
  const LANES = Math.max(1, Math.min(IMG.POOL_SIZE || 2, 4));
  const results = new Array(photos.length);
  let next = 0, finished = 0;

  const shortName = (n) => n.length > 28 ? n.slice(0, 26) + '…' : n;

  async function lane() {
    while (next < photos.length) {
      const i = next++;
      const p = photos[i];
      try {
        const r = await IMG.processPhoto(p.file, lat, lng, (stage) =>
          progress(finished, photos.length,
                   `${stage} — ${shortName(p.file.name)}`));
        results[i] = r;
        p.note = r.wasConverted ? `→ JPEG ${fmtMB(r.bytes.length)}`
               : r.wasRecompressed ? fmtMB(r.bytes.length)
               : 'unchanged';
      } catch (err) {
        results[i] = { error: err.message || 'could not be processed' };
        p.note = 'failed';
      }
      finished++;
      progress(finished, photos.length,
               `Processed ${finished} of ${photos.length}` +
               (finished < photos.length ? ` — ${shortName(photos[Math.min(next, photos.length - 1)].file.name)}` : ''));
      renderGrid();
      await nextFrame();
    }
  }

  progress(0, photos.length, `Processing ${photos.length} photos…`);
  await nextFrame();
  await Promise.all(Array.from({ length: LANES }, lane));

  // Zip in the user's original order, not completion order.
  photos.forEach((p, i) => {
    const r = results[i];
    if (!r || r.error) {
      failed.push(`${p.file.name} — ${r ? r.error : 'could not be processed'}`);
      return;
    }
    let name = r.name;
    if (used.has(name)) {
      const k = used.get(name) + 1;
      used.set(name, k);
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)} (${k})${name.slice(dot)}` : `${name} (${k})`;
    } else {
      used.set(name, 1);
    }
    zip.file(name, r.bytes);
    inTotal  += r.inBytes;
    outTotal += r.bytes.length;
    done++;
  });

  if (!done) {
    bar.hidden = true;
    setNote($('goNote'), 'No photos could be processed. Nothing was downloaded.', 'warn');
  } else {
    progress(done, photos.length, 'Building ZIP…');
    await nextFrame();
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName(society.society_name)}.zip`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    bar.hidden = true;
    const saved = inTotal > outTotal
      ? ` · ${fmtMB(inTotal)} → ${fmtMB(outTotal)}` : '';
    setNote($('goNote'),
      `Done — ${done} photo${done === 1 ? '' : 's'} tagged at ` +
      `${lat.toFixed(6)}, ${lng.toFixed(6)}${saved}.`, 'ok');
  }

  if (failed.length) {
    const ul = $('fails');
    failed.forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f;
      ul.append(li);
    });
    ul.hidden = false;
  }

  busy = false;
  refreshGo(true);
});

const safeName = (s) => s.replace(/[\/\\?%*:|"<>]/g, '-').trim() || 'photos';
