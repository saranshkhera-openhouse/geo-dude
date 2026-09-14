# geo-dude

**Add GPS location to property photos so 99acres will accept them.**

Covers 1,150 housing societies across Gurgaon, Noida and Ghaziabad.

👉 **[Use it here](https://saranshkhera-openhouse.github.io/geo-dude/)** — free, no
sign-up, nothing to install.

---

## The problem

99acres won't publish listing photos that don't carry GPS coordinates. Cameras
write those coordinates inside the image file when location is switched on — and
they go missing when it isn't, or when a photo has been forwarded over WhatsApp,
which strips that data as it compresses the image. Screenshots and downloaded
photos never had them.

So you end up with a folder of perfectly good flat photos that the listing form
refuses.

## What this does

Drop the photos in, pick the society from a list of 1,150 across Gurgaon,
Noida and Ghaziabad, and download them with the right coordinates written in. A whole batch takes a few
seconds.

It also handles the two other things that trip up a listing upload:

- **iPhone HEIC photos** are converted to JPEG automatically.
- **Large photos** are compressed under 2.5 MB so the upload doesn't get
  rejected for size.

**Your photos never leave your device.** There is no server and no account —
all the work happens inside the browser tab. You can disconnect from the
internet after the page loads and it still works.

## How to use it

1. **Add your photos** — drag them in, or tap *browse your files* to pick them
   from your phone's gallery. Picking again adds to the list instead of starting
   over, and the same photo twice is ignored.
2. **Set the location** — type a few letters of the society name and pick it
   from the list. Or switch to **Enter coordinates** and paste a latitude and
   longitude, or a Google Maps link, when your society isn't listed or you want
   a more precise spot than the society centre. Either way, the coordinates
   shown are what gets written into every photo.
3. **Download** — you get one ZIP named after the society. Unzip, and upload.

## Run it yourself

It's a handful of static files, so any web server will do:

```sh
git clone https://github.com/saranshkhera-openhouse/geo-dude.git
cd geo-dude
python3 -m http.server 8080
```

Then open <http://localhost:8080>. (It needs a server rather than opening the
file directly, because browsers block `fetch` of `coords.json` over `file://`.)

To use it from your phone on the same Wi-Fi, find your machine's address with
`ipconfig getifaddr en0` and open `http://<that-address>:8080` there.

## Entering coordinates by hand

Step 2 has a second tab that accepts a location directly. It parses the formats
people actually paste:

| Input | Result |
|---|---|
| `28.505615, 77.092740` | what Google Maps copies |
| `28.505615 77.092740` | whitespace separated |
| `28.505615°N, 77.092740°E` | degree signs and hemisphere letters |
| `77.0927 E, 28.5056 N` | letters decide which number is which |
| `https://…/maps/@28.5056,77.0927,17z` | a shared map link |

Latitude must be within ±90 and longitude within ±180, so a transposed pair is
rejected rather than silently writing a location in the Arabian Sea. Photos
tagged this way download as `photos-28.5056N-77.0927E.zip`.

To get the numbers: in Google Maps, right-click the exact spot and click the
coordinates that appear to copy them.

## Adding a society

`coords.json` is a flat list — add an entry and open a pull request:

```json
{ "society_name": "Your Society Name", "latitude": 28.4595, "longitude": 77.0266 }
```

Or [open an issue](https://github.com/saranshkhera-openhouse/geo-dude/issues)
with the name and location, and it can be added for you.

## How it works

| File | Role |
|---|---|
| `index.html` | The page: three steps, instructions, FAQ |
| `app.css` | Styling, light and dark |
| `image.js` | Format detection, HEIC decode, resize, compress, GPS EXIF |
| `worker.js` | JPEG encoding, off the main thread |
| `app.js` | UI and state |
| `coords.json` | 1,150 societies and their coordinates |

Each photo goes through one pipeline: decode → resize if over 2560 px on the
long edge → encode at the best quality that fits 2.5 MB → write GPS EXIF → zip.

A few details worth knowing:

- **Formats are detected from magic bytes**, not the file extension, because iOS
  often reports a HEIC's MIME type as an empty string.
- **JPEGs already under both caps pass through untouched** — pixels and all other
  metadata preserved, with only GPS tags added.
- **Encoding runs in a Worker pool** sized to the device. It's the whole cost of
  a photo (~500 ms for 12 MP on a phone), so moving it off the main thread keeps
  the page responsive; there's an inline fallback where Workers or
  `OffscreenCanvas` aren't available.
- **The HEIC decoder is loaded lazily**, only when you actually pick a HEIC, so
  JPEG-only batches don't download 1.3 MB for nothing.

Tags written: `GPSLatitude`, `GPSLatitudeRef`, `GPSLongitude`, `GPSLongitudeRef`,
`GPSMapDatum` (WGS-84), `GPSVersionID`.

To change the limits, edit `MAX_EDGE` and `MAX_BYTES` at the top of `image.js`.

## Verify a result

```sh
exiftool -GPSLatitude -GPSLongitude -GPSPosition photo.jpg
```

Or drop a tagged photo into Apple Photos or Google Photos and check it appears
on the map at the right society.

## Notes

- Covers 1,150 societies across Gurgaon, Noida and Ghaziabad.
- Every photo in a batch gets the same coordinates — the society's centre point,
  not the precise spot each photo was taken.
- Transparent PNG areas are flattened onto white, since JPEG has no alpha.
- A converted HEIC or PNG has no original EXIF to preserve, so its output
  carries the GPS tags alone.
- If one photo fails, it's skipped and named in a warning; the rest still
  download.

## License

MIT — see [LICENSE](LICENSE).

---

Not affiliated with or endorsed by 99acres. It is simply the site whose photo
requirement this was built for.
