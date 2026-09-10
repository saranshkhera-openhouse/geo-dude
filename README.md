# geo-dude

Stamp a society's GPS coordinates into the EXIF metadata of a batch of photos.
Runs entirely in your browser — **no photo is ever uploaded anywhere.**

## Run it

The page reads `coords.json` with `fetch`, which browsers block on `file://`.
So serve the folder:

```sh
cd geo-dude
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Use it

1. **Choose photos** — drag and drop, or browse. Pick as many times as you like;
   new photos are added to the list rather than replacing it. Duplicates are
   ignored. Remove any photo with the ✕ on its thumbnail.
2. **Choose society** — start typing to search all 1150 societies from
   `coords.json`. Arrow keys + Enter, or click. The matched lat/long is shown.
3. **Tag & download** — every selected photo gets that society's exact
   coordinates written to its GPS EXIF tags, and they all come back as
   `<Society Name>.zip` with the original filenames.

## Notes

- **JPEG only.** PNG and HEIC can't carry EXIF GPS tags, so non-JPEG files are
  rejected when you pick them, with a message saying which.
- Existing metadata is preserved — only the GPS tags are added or replaced.
  Re-tagging an already-tagged photo simply overwrites its coordinates.
- Tags written: `GPSLatitude`, `GPSLatitudeRef`, `GPSLongitude`,
  `GPSLongitudeRef`, `GPSMapDatum` (WGS-84), `GPSVersionID`.
- If a single photo fails to parse, it's skipped and named in a warning; the
  rest are still tagged and downloaded.

## Verify a result

```sh
exiftool -GPSLatitude -GPSLongitude -GPSPosition photo.jpg
```

Or just drop the tagged photo into Apple Photos / Google Photos and check that
it appears on the map at the right society.
