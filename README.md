# geo-dude

Stamp a society's GPS coordinates into the EXIF metadata of a batch of photos.
Runs entirely in your browser — **no photo is ever uploaded anywhere.**

## Run it

The page reads `coords.json` with `fetch`, which browsers block on `file://`.
So serve the folder:

```sh
cd geo-dude
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

**To use it from your phone** on the same Wi-Fi, find your machine's LAN
address (`ipconfig getifaddr en0` on macOS) and open
`http://<that-address>:8080` there.

## Use it

1. **Choose photos** — drag and drop, or browse. Pick as many times as you like;
   new photos are added to the list rather than replacing it. Duplicates are
   ignored. Remove any photo with the ✕ on its thumbnail.
2. **Choose society** — start typing to search all 1150 societies from
   `coords.json`. Arrow keys + Enter, or click. The matched lat/long is shown.
3. **Tag & download** — every photo gets that society's exact coordinates
   written to its GPS EXIF tags, and they all come back as `<Society Name>.zip`
   with the original filenames.

## Input formats

**JPEG, HEIC/HEIF, PNG and WebP** are all accepted, and everything is saved as
JPEG — the only common format that carries EXIF GPS tags. HEIC and PNG files
are converted automatically and renamed to `.jpg`.

Formats are detected by reading magic bytes, not the file extension, because
iOS often reports a HEIC's MIME type as empty. GIF and AVIF are rejected at
pick time with a message naming the files.

The HEIC decoder (~1.3 MB) is only downloaded the first time you actually pick
a HEIC, so JPEG-only batches don't pay for it. HEIC conversion is CPU-heavy —
expect a second or two per photo on a laptop, longer on a phone. The progress
bar names the file it's working on.

## Compression

Output photos are capped at **2.5 MB** and **2560 px on the long edge**:

- A photo already under both caps is **passed through untouched** — its pixels
  and all its other metadata are preserved, and only GPS tags are added.
- A larger one is resized to 2560 px, then encoded at the highest quality in
  `0.92 → 0.85 → 0.78 → 0.70 → 0.62 → 0.54` that lands under 2.5 MB.

2560 px stays sharp on any screen while cutting a 12 MP phone photo to roughly
a fifth of its size. Each thumbnail shows its result, and the summary reports
the total saving (e.g. `37.2 MB → 7.1 MB`).

To change the caps, edit `MAX_EDGE` and `MAX_BYTES` at the top of
[`image.js`](image.js).

## Notes

- Existing metadata is preserved on JPEGs — only the GPS tags are added or
  replaced. Re-tagging an already-tagged photo overwrites its coordinates.
  A converted HEIC/PNG has no original EXIF to keep, so its output carries the
  GPS tags alone.
- Transparent PNG areas are flattened onto white, since JPEG has no alpha.
- Tags written: `GPSLatitude`, `GPSLatitudeRef`, `GPSLongitude`,
  `GPSLongitudeRef`, `GPSMapDatum` (WGS-84), `GPSVersionID`.
- If a single photo fails, it's skipped and named in a warning; the rest are
  still tagged and downloaded.

## Files

| File | Role |
|---|---|
| `index.html` | Markup for the three steps |
| `app.css` | Styling, light + dark |
| `image.js` | Image pipeline: format sniffing, HEIC decode, resize, compress, GPS EXIF |
| `app.js` | UI and state only |
| `coords.json` | The 1150 societies and their coordinates |

## Verify a result

```sh
exiftool -GPSLatitude -GPSLongitude -GPSPosition photo.jpg
```

Or drop a tagged photo into Apple Photos / Google Photos and check that it
appears on the map at the right society.
