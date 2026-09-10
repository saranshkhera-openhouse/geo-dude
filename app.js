/* geo-dude — stamp society GPS coords into JPEG EXIF, entirely client-side. */
'use strict';

/* ---------- GPS / EXIF ---------------------------------------------------- */

/* Decimal degrees -> EXIF rational DMS, e.g. 28.502937 ->
   [[28,1],[30,1],[105493,10000]]. Seconds keep 4 decimal places (~0.003 m). */
function toDMS(deg) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const sec = (minFloat - m) * 60;
  return [[d, 1], [m, 1], [Math.round(sec * 10000), 10000]];
}

/* Return a new JPEG data-URL with GPS tags set to lat/lng.
   All non-GPS metadata in the original is preserved. */
function stampGps(dataUrl, lat, lng) {
  let exif;
  try {
    exif = piexif.load(dataUrl);
  } catch (e) {
    // No/!unreadable EXIF — start a fresh, otherwise-empty structure.
    exif = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
  }
  exif.GPS = exif.GPS || {};
  const G = piexif.GPSIFD;
  exif.GPS[G.GPSVersionID]    = [2, 3, 0, 0];
  exif.GPS[G.GPSLatitudeRef]  = lat >= 0 ? 'N' : 'S';
  exif.GPS[G.GPSLatitude]     = toDMS(lat);
  exif.GPS[G.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
  exif.GPS[G.GPSLongitude]    = toDMS(lng);
  exif.GPS[G.GPSMapDatum]     = 'WGS-84';
  return piexif.insert(piexif.dump(exif), dataUrl);
}

/* ---------- small helpers ------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const readAsDataURL = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload  = () => res(r.result);
  r.onerror = () => rej(r.error || new Error('could not read file'));
  r.readAsDataURL(file);
});

const dataUrlToBytes = (dataUrl) => {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const isJpeg = (f) => /^image\/jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name);

/* Filesystem-safe zip name, and unique names inside the zip. */
const safeName = (s) => s.replace(/[\/\\?%*:|"<>]/g, '-').trim() || 'photos';

/* ---------- state --------------------------------------------------------- */

const photos = [];        // { key, file, url }
let societies = [];       // { society_name, latitude, longitude }
let society = null;       // selected society
let busy = false;

/* ---------- step 1 : photos ---------------------------------------------- */

const drop = $('drop'), fileInput = $('file'), grid = $('grid');

function addFiles(fileList) {
  const incoming = Array.from(fileList);
  const skipped = [];
  let added = 0, dupes = 0;

  for (const file of incoming) {
    if (!isJpeg(file)) { skipped.push(file.name); continue; }
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (photos.some((p) => p.key === key)) { dupes++; continue; }
    photos.push({ key, file, url: URL.createObjectURL(file) });
    added++;
  }

  const bits = [];
  if (added)  bits.push(`Added ${added} photo${added === 1 ? '' : 's'}.`);
  if (dupes)  bits.push(`${dupes} already in the list.`);
  if (skipped.length) {
    bits.push(`Skipped ${skipped.length} non-JPEG file${skipped.length === 1 ? '' : 's'} ` +
              `(${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}) — ` +
              `only JPEG can carry GPS metadata.`);
  }
  setNote($('pickNote'), bits.join(' '), skipped.length ? 'warn' : '');
  renderGrid();
}

function renderGrid() {
  grid.textContent = '';
  for (const p of photos) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = p.url; img.alt = p.file.name; img.loading = 'lazy';
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.textContent = '×';
    x.title = `Remove ${p.file.name}`;
    x.setAttribute('aria-label', `Remove ${p.file.name}`);
    x.addEventListener('click', () => removePhoto(p.key));
    li.append(img, x);
    grid.append(li);
  }
  $('count').textContent = photos.length;
  $('countWord').textContent = photos.length === 1 ? 'photo' : 'photos';
  $('gridHead').hidden = photos.length === 0;
  refreshGo();
}

function removePhoto(key) {
  const i = photos.findIndex((p) => p.key === key);
  if (i < 0) return;
  URL.revokeObjectURL(photos[i].url);
  photos.splice(i, 1);
  renderGrid();
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
// Reset value so re-picking the same file still fires change.
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

$('clear').addEventListener('click', () => {
  photos.forEach((p) => URL.revokeObjectURL(p.url));
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
      `see the README for the one-line command.`, 'warn');
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

const go = $('go');

function setNote(el, msg, cls) {
  el.textContent = msg;
  el.className = 'note' + (cls ? ' ' + cls : '');
}

function refreshGo(keepNote) {
  if (busy) return;
  const ready = photos.length > 0 && society !== null;
  go.disabled = !ready;
  if (keepNote) return;            // preserve the post-run summary
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

  const lat = +society.latitude, lng = +society.longitude;
  const zip = new JSZip();
  const used = new Map();   // de-duplicate names inside the zip
  const failed = [];
  let done = 0;

  for (const p of photos) {
    setNote($('goNote'), `Tagging ${done + 1} of ${photos.length}…`);
    // Yield so the note actually paints between files.
    await new Promise((r) => setTimeout(r, 0));
    try {
      const tagged = stampGps(await readAsDataURL(p.file), lat, lng);
      let name = p.file.name;
      if (used.has(name)) {
        const n = used.get(name) + 1;
        used.set(name, n);
        const dot = name.lastIndexOf('.');
        name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      } else {
        used.set(name, 1);
      }
      zip.file(name, dataUrlToBytes(tagged));
      done++;
    } catch (err) {
      // piexif surfaces low-level parser errors; show something readable instead.
      failed.push(`${p.file.name} — not a readable JPEG, so it was skipped.`);
      console.error('geo-dude: failed on', p.file.name, err);
    }
  }

  if (!done) {
    setNote($('goNote'), 'No photos could be tagged. Nothing was downloaded.', 'warn');
  } else {
    setNote($('goNote'), 'Building ZIP…');
    const blob = await zip.generateAsync({ type: 'blob' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${safeName(society.society_name)}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setNote($('goNote'),
      `Done — ${done} photo${done === 1 ? '' : 's'} tagged at ` +
      `${lat.toFixed(6)}, ${lng.toFixed(6)} and downloaded.`, 'ok');
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
  refreshGo(true);   // keep the "Done — …" / failure summary on screen
});
