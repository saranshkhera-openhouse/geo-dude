/* geo-dude hero map — plot every society from coords.json to scale, so the
   coverage claim is shown rather than asserted. Progressive: the <svg> stays
   empty and hidden until the data actually loads. */
'use strict';

(function () {
  const svg = document.getElementById('map');
  if (!svg) return;

  // Mercator-ish is overkill across 60 km; scale longitude by cos(lat) instead.
  const LAT0 = 28.5, KX = Math.cos(LAT0 * Math.PI / 180);

  fetch('coords.json')
    .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
    .then((rows) => {
      const pts = rows
        .filter((s) => Number.isFinite(+s.latitude) && Number.isFinite(+s.longitude))
        .map((s) => ({ x: +s.longitude * KX, y: +s.latitude, name: s.society_name }));
      if (!pts.length) return;

      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      const PAD = 14, W = 420, H = Math.round(W * ((y1 - y0) / (x1 - x0)));
      svg.setAttribute('viewBox', `0 0 ${W} ${H + PAD}`);

      const sx = (x) => PAD + ((x - x0) / (x1 - x0)) * (W - PAD * 2);
      const sy = (y) => (H - PAD) - ((y - y0) / (y1 - y0)) * (H - PAD * 2);

      const NS = 'http://www.w3.org/2000/svg';
      const frag = document.createDocumentFragment();

      pts.forEach((p) => {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', sx(p.x).toFixed(1));
        c.setAttribute('cy', sy(p.y).toFixed(1));
        c.setAttribute('r', '1.9');
        c.setAttribute('class', 'dot');
        // Stagger by position so the draw-in sweeps across the region.
        c.style.animationDelay = `${(sx(p.x) / W) * 900 + Math.random() * 260}ms`;
        frag.append(c);
      });

      // City labels, placed from each cluster's own centroid.
      // dx/dy nudge each label clear of its own cluster and of its neighbour;
      // Noida and Ghaziabad overlap vertically, so they are pushed apart.
      const CITIES = [
        { label: 'Gurgaon',   dx: -18, dy: -12,
          test: (p) => p.x / KX < 77.2 },
        { label: 'Noida',     dx: -34, dy:  16,
          test: (p) => p.x / KX >= 77.2 && !(p.y >= 28.60 && p.x / KX >= 77.35) },
        { label: 'Ghaziabad', dx:  34, dy: -20,
          test: (p) => p.y >= 28.60 && p.x / KX >= 77.35 },
      ];
      CITIES.forEach(({ label, test, dx, dy }) => {
        const group = pts.filter(test);
        if (group.length < 20) return;
        // Median is steadier than the mean when a few outliers sit far out.
        const med = (a) => { const v = [...a].sort((m, n) => m - n); return v[v.length >> 1]; };
        const cx = sx(med(group.map((p) => p.x)));
        const cy = sy(med(group.map((p) => p.y)));
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', (cx + dx).toFixed(1));
        t.setAttribute('y', (cy + dy).toFixed(1));
        t.setAttribute('class', 'city');
        t.setAttribute('text-anchor', 'middle');
        t.textContent = `${label} · ${group.length}`;
        frag.append(t);
      });

      svg.append(frag);
      // `hidden` is reflected on HTMLElement, not SVGElement — setting the
      // property here would leave the attribute (and display:none) in place.
      svg.removeAttribute('hidden');
      svg.removeAttribute('aria-hidden');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label',
        `Map of ${pts.length} housing societies across Gurgaon, Noida and Ghaziabad`);
      svg.closest('.mapwrap')?.classList.add('ready');
    })
    .catch(() => { /* map is decorative; the tool works without it */ });
})();
