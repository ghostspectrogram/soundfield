# Soundfield: optimization and cleanup pass (2026-10-12)

This note is written for another Claude working on its own copy of Soundfield, the Electron sound-effects explorer. It lists every change from one audit pass. Each entry gives the problem, the fix, and the code, so you can decide what applies to your copy and port it.

Your copy may have drifted from this one. Match each change by **behaviour**, not by line number.

**How to use this note**
- Treat each section as independent: take the ones whose problem exists in your copy.
- Before porting a fix, check that the problem really exists in your copy. Each section says what to look for.
- After any change, run the app and rebuild the standalone exe (`node tools/build.js --wait`; never kill a running Soundfield).
- Don't round-trip source files through PowerShell `Get-Content`/`Set-Content`: it garbles UTF-8 characters such as `…` and `−`. Use a proper edit tool or Node scripts.

**Files touched:** `main.js`, `lib/online.js`, `lib/scan-worker.js`, `renderer/js/app.js`, `renderer/js/online.js`, `renderer/js/waveform.js`, `renderer/js/engine.js`, `renderer/js/layouts.js`, `renderer/index.html`, `renderer/styles.css`, `README.md`.

---

## 1. Bugs

### 1.1 Switching sounds quickly could kill the new sound (and leak file handles)

**Where:** `main.js` (`file:read` IPC) and `renderer/js/engine.js` (`pump()`).

**What was wrong**

The main process kept one shared "open file" handle (`openHandle` / `handleFor(p)`). Reading a new file closed the previous handle, even if a read on it was still in flight. That in-flight read then failed with EBADF.

There was also a race: two concurrent opens for different files both saw `openHandle === null`. The second one overwrote the first without closing it, so a file handle leaked.

In the renderer, `Engine.pump()` caught *any* read error, emitted `error` (which shows a "Playback error…" toast) and called `this.stop()`. So a stale read from the *previous* sound could stop the sound that had just started.

**Fix, part 1 (main.js):** replace the single handle with a small reference-counted pool. A handle closes only when no read uses it, after 4 s idle, and at most 3 stay open while idle.

```js
// Files being streamed stay open between reads. A handle is only closed once no read is using
// it, so switching sounds mid-read can't break the read that's still running.
const handles = new Map(); // path -> { fh: Promise<FileHandle>, users, timer }
function closeHandle(p, h) {
  if (handles.get(p) === h) handles.delete(p);
  h.fh.then(fh => fh.close()).catch(() => {});
}
async function withHandle(p, fn) {
  let h = handles.get(p);
  if (!h) {
    h = { fh: fsp.open(p, 'r'), users: 0, timer: null };
    handles.set(p, h);
    h.fh.catch(() => { if (handles.get(p) === h) handles.delete(p); });
  }
  clearTimeout(h.timer);
  h.users++;
  try {
    return await fn(await h.fh);
  } finally {
    if (--h.users === 0) {
      h.timer = setTimeout(() => closeHandle(p, h), 4000);
      // Keep only a few idle files open.
      const idle = [...handles].filter(([, x]) => x.users === 0);
      for (const [q, x] of idle.slice(0, Math.max(0, idle.length - 3))) { clearTimeout(x.timer); closeHandle(q, x); }
    }
  }
}

ipcMain.handle('file:read', (e, p, offset, length) => withHandle(p, async fh => {
  const buf = Buffer.allocUnsafeSlow(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
}));
```

**Fix, part 2 (main.js `file:trash`):** right after the user confirms, close idle handles on the paths being recycled:

```js
for (const p of paths) { const h = handles.get(p); if (h && !h.users) { clearTimeout(h.timer); closeHandle(p, h); } }
```

**Fix, part 3 (engine.js, the catch block in `pump()`):** ignore errors from a feed that is no longer current.

```js
} catch (err) {
  if (this.feed !== f) return; // a read for a sound that's no longer playing
  console.error('stream error', err);
  this.emit('error', err);
  this.stop();
}
```

**Verified:** with playback on, the test switched through 8 PCM files 60 ms apart. Result: 0 engine errors, and the last sound kept playing.

### 1.2 Removing a library mid-analysis re-created its deleted analysis file

**Where:** `main.js`, the analysis worker's `exit` handler.

**What was wrong:** `lib:remove` terminates the analysis worker and deletes `analysis/<id>.json`. The worker's `exit` handler then saved the cache again, leaving an orphan file.

**Fix:** only save the cache if the library still exists.

```js
w.on('exit', () => {
  if (libraries.some(l => l.id === id)) store.saveAnalysis(id, cache); // not for a library removed meanwhile
  ...
```

### 1.3 Epidemic preview job: the inner download could be dropped from the dedupe map

**Where:** `main.js`, `fetchPreview()`.

**What was wrong:** for Epidemic results without a preview URL, an outer promise fetched a signed URL and then called `fetchPreview` again. The inner call registered its own job, and the outer `.finally` deleted that entry while the inner download was still running. A second click could start a duplicate download.

**Fix:** make it a single job.

```js
const previewJobs = new Map(); // file -> Promise
function fetchPreview(r) {
  const file = previewFile(r);
  if (fs.existsSync(file)) {
    fs.promises.utimes(file, new Date(), new Date()).catch(() => {}); // recently played previews are kept longest
    return Promise.resolve(file);
  }
  if (previewJobs.has(file)) return previewJobs.get(file);
  let last = 0;
  const progress = (got, total) => {
    if (Date.now() - last < 120) return;
    last = Date.now();
    send('preview:progress', { key: r.key, got, total });
  };
  const get = async () => {
    // Epidemic results from the developer key carry no preview link; one is asked for with the account key.
    const url = r.source === 'epidemic' && !r.previewUrl ? await epiFileUrl(r.id, 'MP3') : r.previewUrl;
    if (!/^https:\/\//.test(url || '')) throw new Error('No preview available');
    const hint = previewSizeHint(r);
    await (hint ? online.downloadRanges(url, file, hint, progress) : online.download(url, file, {}, progress));
    prunePreviews();
    return file;
  };
  const job = get().finally(() => previewJobs.delete(file));
  previewJobs.set(file, job);
  return job;
}
```

The `utimes` touch on a cache hit turns the cache cleanup in §2.1 into least-recently-used.

### 1.4 Small UI and text bugs

| Where | What was wrong | Fix |
|---|---|---|
| `renderer/js/online.js` `LIC_NAMES` | "Copy credit line" on an Epidemic sound ended in the raw word `epidemic` | Add `epidemic: 'Epidemic Sound licence (your subscription)'` |
| `renderer/js/online.js` result right-click menu | Label said "Save to Soundfield Downloads" even with a custom Save to folder | `` label: `Save to ${destLabel()}` `` |
| `renderer/js/online.js` Save button tooltip | Fell back to a hard-coded path | Use `S.saveDir \|\| defaultDir \|\| 'Documents\\Soundfield Downloads'` |
| `renderer/index.html` `#o-empty` text | Named only Freesound + Commons and a fixed folder | Mention Internet Archive, Epidemic and the *Save to* folder |
| `lib/online.js` header comment | Called Epidemic "a site without a search API" | Describe the MCP / Partner API setup |

---

## 2. Performance and disk space

### 2.1 The preview cache had no size limit (it had reached 541 MB)

**Where:** `main.js`, `prunePreviews()`.

**What was wrong**
- The cache kept the newest 300 *files* regardless of size. Internet Archive and Commons previews can be 20 to 120 MB each.
- Interrupted downloads left `*.part` files behind.
- The prune ran a synchronous `readdir` and `stat` of every file after *every* download.

**Fix:** cap the cache at 300 files **and** 300 MB, remove `.part` files older than 1 h, never delete anything touched in the last 10 minutes (it may be playing), and run at most once a minute, plus a forced run 8 s after the window loads.

```js
// The preview cache keeps the most recent 300 files / 300 MB. Half-finished downloads left
// behind by a crash are removed too. Runs at most once a minute.
let prunedAt = 0;
function prunePreviews(force) {
  if (!force && Date.now() - prunedAt < 60000) return;
  prunedAt = Date.now();
  const dir = previewDir();
  let files;
  try { files = fs.readdirSync(dir); } catch { return; }
  const list = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (f.endsWith('.part')) { if (Date.now() - st.mtimeMs > 3600e3) fs.unlinkSync(p); continue; }
      list.push({ p, t: st.mtimeMs, size: st.size });
    } catch {}
  }
  list.sort((a, b) => b.t - a.t);
  let total = 0;
  list.forEach((f, i) => {
    total += f.size;
    const recent = Date.now() - f.t < 600e3; // may be playing right now
    if (!recent && (i >= 300 || total > 300 * 1024 * 1024)) { try { fs.unlinkSync(f.p); } catch {} }
  });
}

// in the boot code, next to the delayed library rescan:
setTimeout(() => prunePreviews(true), 8000);
```

**Verified** with dummy files: the cap was enforced, the old `.part` file was deleted and the fresh file was kept.

### 2.2 Big Wikimedia Commons originals were downloaded in full just to preview

**Where:** `lib/online.js` `searchCommons()`, `main.js` `online:download`, `renderer/js/app.js` `renderMeta()`.

**What was wrong:** Commons previews used the original file, so one preview was a 116 MB WAV. Commons keeps an MP3 copy of every audio file.

**Fix**
- Ask the API for `videoinfo` with `derivatives` instead of `imageinfo`. The other fields are the same; the metadata filter parameter becomes `viextmetadatafilter`. Same hits, same licences: checked side by side.
- For **WAV/FLAC** originals over 1.5 MB, preview the `mp3` derivative.
- Keep the original as `downloadUrl` so Save still gets the real file.
- Don't do this for OGG/MP3 originals: the MP3 copy can be *larger* than an OGG.

```js
// Big WAV / FLAC originals are previewed through the MP3 copy Commons makes of every audio file.
const COMMONS_PREVIEW_MIN = 1.5 * 1024 * 1024;
// params:
prop: 'videoinfo|categories', viprop: 'url|size|mime|extmetadata|derivatives', cllimit: 'max', clshow: '!hidden',
viextmetadatafilter: 'LicenseShortName|License|LicenseUrl|Artist|ImageDescription|ObjectName',
// per page:
const ii = p.videoinfo && p.videoinfo[0];
...
const original = ii.url.split('?')[0];
const mp3 = (ext === 'wav' || ext === 'flac') && (ii.size || 0) > COMMONS_PREVIEW_MIN
  && (ii.derivatives || []).find(d => d.transcodekey === 'mp3' && /^https:\/\//.test(d.src || ''));
// result fields:
previewUrl: mp3 ? mp3.src.split('?')[0] : original, previewExt: mp3 ? 'mp3' : ext, previewIsOriginal: !mp3,
downloadUrl: original, original: true,
```

**Other changes this needs**
- In `online:download`, delete the special `r.source === 'commons'` branch. Commons results now have `downloadUrl`, so the generic `else if (r.downloadUrl) { url = r.downloadUrl; quality = 'original'; ext = r.ext; }` covers them.
- In `renderMeta()`, the "Playing" row is now `o.previewIsOriginal ? 'Original file' : 'Preview (MP3)'`. It used to treat every Commons file as the original.

**Verified:** the 116 MB WAV now previews from a 4.3 MB MP3 in 0.3 s. Save still writes the 121 MB original WAV.

### 2.3 Saving a sound you just previewed downloaded it again

**Where:** `main.js` `online:download`.

**Fix:** when the preview *is* the original file (`previewIsOriginal`, which covers Internet Archive and small Commons files) and it's already cached, copy it from the cache.

```js
// Same file as the preview you just listened to: reuse it instead of downloading again.
const cached = quality === 'preview' || (r.previewIsOriginal && fs.existsSync(previewFile(r)));
if (cached) {
  const from = await fetchPreview(r);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(from, dest);
} else { /* online.download(url, dest, headers, progress) as before */ }
```

**Verified:** saving a previewed 2 MB OGG took 9 ms.

### 2.4 Chromium's disk cache kept a second copy of every download (131 MB)

**Where:** `lib/online.js` `download()`.

**Fix:** pass `cache: 'no-store'` to `net.fetch`, because Soundfield keeps the files itself.

```js
const get = () => net.fetch(url, { headers: { 'User-Agent': UA, ...headers }, cache: 'no-store' });
let r = await get();
for (let tries = 0; r.status >= 500 && tries < 2; tries++) { /* drain, wait 800 ms */ r = await get(); }
```

The parallel range downloader uses Node's `https`, so it was never affected.

### 2.5 Every launch rewrote all library indexes and rebuilt the whole list, even with no changes

**Where:** `lib/scan-worker.js`, `main.js` `pumpScans()`, `renderer/js/app.js` (`scan:progress`).

**What was wrong:** about 1.5 s after launch, every library is rescanned. Even when nothing had changed, each rescan:
- rewrote `index/<id>.json` (MBs of JSON, written synchronously in the main process),
- sent every record over IPC,
- made the renderer rebuild every item, including the categorisation regexes for each file,
- marked duplicate results "stale".

**Fix, scan worker:** report when nothing changed. It already reuses the *same record object* for unchanged files, so object identity is enough:

```js
// Nothing added, removed or changed: the caller can keep what it has.
const unchanged = records.length === prevMap.size && records.every(r => prevMap.get(r.rel) === r);
parentPort.postMessage(unchanged ? { type: 'done', unchanged: true, count: records.length } : { type: 'done', records });
```

**Fix, main.js** (`done` handler and `finish`):

```js
} else if (m.type === 'done') {
  if (!libraries.includes(lib)) return; // removed mid-scan
  lib.offline = false;
  lib.scannedAt = Date.now();
  if (m.unchanged) {
    // Same files as last time: no need to rewrite the index or resend it.
    scanning.unchanged = true;
    lib.count = m.count;
    saveLibs();
    send('lib:status', libPublic(lib));
  } else {
    lib.count = m.records.length;
    store.saveIndex(id, m.records);
    saveLibs();
    send('lib:updated', { lib: libPublic(lib), records: m.records });
  }
  queueAnalysis(id);
}
// in finish():
const changed = !(scanning && scanning.unchanged);
send('scan:progress', { id, phase: 'end', changed });
```

**Fix, renderer:** only mark duplicates stale when something changed.

```js
if (p.phase === 'end') {
  S.scans.delete(p.id);
  if (p.changed !== false) { if (S.dupesRaw) S.dupesRaw.stale = true; if (S.dupes) S.dupes.stale = true; }
}
```

**Verified:** the index files kept their original timestamps after a full launch and rescan.

### 2.6 Category analysis rewrote its cache file several times a minute

**Where:** `main.js` `pumpAnalysis()`.

**What was wrong:** every results batch (every ~1.5 s) rewrote `analysis/<id>.json` synchronously. That file holds the whole library's cache and can be several MB.

**Fix:** save at most every 15 s while analysing, plus once on exit (see §1.2). The worst case on a crash is redoing 15 s of listening.

```js
let savedAt = Date.now();
w.on('message', m => {
  if (m.type === 'results') {
    ...
    if (Object.keys(m.results).length && Date.now() - savedAt > 15000) { store.saveAnalysis(id, cache); savedAt = Date.now(); }
```

### 2.7 Opening a project scanned the whole library on every filter pass

**Where:** `renderer/js/app.js` `applyFilters()`, `itemsByPath()`.

**What was wrong**
- In project scope, `applyFilters` looped over *all* items and lower-cased every path to look it up in the project index.
- `itemsByPath()` (path → item map) was rebuilt from scratch on every call. The project banner, missing-file checks, the project list and relink all call it, several times per filter pass.

**Fix, part 1:** memoize the map. This is safe because `S.items` is always *replaced*, never mutated in place. Grep your copy for `S.items.push`, `splice` and similar to confirm before porting.

```js
// Lower-case path -> item, rebuilt only when the item list changes (it's always replaced, never edited).
let byPathCache = { items: null, map: null };
function itemsByPath() {
  if (byPathCache.items !== S.items) {
    const m = new Map();
    for (const it of S.items) if (!it.zip) m.set(lowPath(it.path), it);
    byPathCache = { items: S.items, map: m };
  }
  return byPathCache.map;
}
// The project's sounds that are in a linked library.
function projectItems(p) {
  if (!p) return [];
  const byPath = itemsByPath(), out = [];
  for (const r of p.items) { const it = byPath.get(lowPath(r.path)); if (it) out.push(it); }
  return out;
}
```

**Fix, part 2 (in `applyFilters`):** iterate over the project's own sounds and drop the per-item project check.

```js
const pool = sc.type === 'proj' ? projectItems(projectById(sc.id)) : S.items;
for (const it of pool) {
  // (removed) if (sc.type === 'proj' && !(S.projIndex.get(lowPath(it.path)) || []).some(p => p.id === sc.id)) continue;
```

**Verified** on a 30,738-sound library: a 377-sound project filters in 4 ms instead of 24 ms.

### 2.8 Soundfield search waited for the slowest site before showing anything

**Where:** `renderer/js/online.js` `runSearch()`, `lib/online.js` `getJson()`, `iaJson()`, `searchArchive()`, `mcpPost()`.

**What was wrong**
- The renderer made one `online:search` call for all sources, and the main process waited on `Promise.allSettled`. So nothing appeared until every site had answered.
- Freesound and Commons answer in 0.1–0.6 s. The Internet Archive usually takes about 0.5 s, but now and then one item's `/metadata/<id>/files` request stalls for 20+ s.
- `net.fetch` has no timeout of its own, so a stalled request could hang the search indefinitely.

**Fix, part 1 (renderer):** call `online:search` once **per source** (`sources: [src]`) and render each answer as it arrives. The main process didn't need any change for this.
- Results are interleaved by source *only while the user is just waiting* (nothing selected, list scrolled to the top). That puts each source's best hits near the top.
- Once the user clicks or scrolls, or for page 2 onwards, late arrivals are appended so rows don't move under the cursor.
- The status line shows "Still searching Internet Archive…" (kept in `O.pending`).
- Prefetch and list focus happen on the first non-empty arrival.

```js
const interleave = lists => {
  const out = [];
  for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
};
// in runSearch, after the reset / page++ bookkeeping:
const tok = ++O.tok, page = O.page, types = fileTypes();
const base = O.results.slice(); // earlier pages stay where they are
const lists = {};               // this page's results, per source
let settled = page > 1, started = false;
O.pending = new Set(srcs);
O.loading = true;
render();
await Promise.all(srcs.map(async src => {
  let res = null;
  try { res = await api.online.search({ query: q, page, sources: [src], licenses: ['cc0', 'pd'], types }); }
  catch (err) { if (tok === O.tok) O.errors[src] = ipcMessage(err); }
  if (tok !== O.tok) return;
  O.pending.delete(src);
  O.loading = O.pending.size > 0;
  O.more[src] = !!(res && res.more[src]);
  if (res) {
    if (res.totals && res.totals[src] != null) O.totals[src] = res.totals[src];
    Object.assign(O.errors, res.errors);
    O.via = res.via;
    const fresh = res.results.filter(r => !O.seen.has(r.key));
    for (const r of fresh) O.seen.add(r.key);
    lists[src] = fresh;
    if (list.selected >= 0 || listEl.scrollTop > 0) settled = true;
    if (settled) O.results.push(...fresh);
    else O.results = base.concat(interleave(srcs.map(s => lists[s] || [])));
  }
  render();
  if (reset && !started && O.results.length) { started = true; if (document.activeElement !== input) listEl.focus(); prefetch(O.results.slice(0, 2)); }
}));
```

**Fix, part 2 (main process timeouts)**
- `getJson(url, headers, timeout = 20000)` passes `signal: AbortSignal.timeout(timeout)` to `net.fetch`. On a `TimeoutError` / `AbortError` it throws "<host> took too long to answer. Try again in a moment."
- `mcpPost` (Epidemic) does the same with a 30 s limit.
- Internet Archive file-list requests use a 6 s limit (`IA_FILES_TIMEOUT`); a slow item is skipped.
- `searchArchive` fetches all 12 file lists at once (`Promise.all`) instead of 4 at a time.

**Verified:** Freesound results appear at about 0.1–0.6 s and Commons by about 0.6 s. Before, the list was blank until the slowest source finished (up to 23 s). `AbortSignal.timeout` works with `net.fetch` in Electron 44: a test request gave up after 1.5 s as set.

### 2.9 Smaller wins

- **`renderer/js/waveform.js` `paintPeaks`:** reuse the three `Float32Array(W)` column buffers between paints instead of allocating them for every channel on every frame:
  ```js
  if (!this.cols || this.cols.top.length !== W) this.cols = { top: new Float32Array(W), bot: new Float32Array(W), rt: new Float32Array(W) };
  const { top, bot, rt } = this.cols;
  ```
- **`renderer/js/online.js` `sorted()`:** create the `Intl.Collator` once at module level instead of on every render.
- **`lib/online.js` `searchEpidemicMcp`:** `mcpCursors` (search term → page cursors) grew without limit; it now keeps the 50 most recent searches.
  ```js
  if (page === 1) {
    mcpCursors.delete(term);
    mcpCursors.set(term, cursors.slice(0, 1));
    if (mcpCursors.size > 50) mcpCursors.delete(mcpCursors.keys().next().value); // forget old searches
  }
  ```

---

## 3. Dead code removed

Only remove an item after grepping your copy to confirm it's really unused.

| Where | Removed | Why it was dead |
|---|---|---|
| `lib/online.js` | `epidemicFileUrl()` and its export; `epiHeaders()` with its `auth.bearer` handling | Left over from the abandoned Epidemic "Connect"/OAuth path. Previews and saves use the MCP server (`epidemicAssetUrl`). The Partner API search now builds its headers inline: `{ Authorization: 'Bearer ' + auth.apiKey, 'x-partner-user-id': 'soundfield-desktop' }` |
| `lib/online.js` `download()` | The comment about Freesound redirect names | Described behaviour that didn't exist |
| `main.js` `getDragIcon()` | The ~15-line procedural bitmap fallback | `build/icon.png` is always packaged. It's now `nativeImage.createFromPath(...icon.png).resize({ width: 40, height: 40, quality: 'best' })` |
| `main.js` `online:download` | The `r.source === 'commons'` branch | Covered by `downloadUrl` (§2.2) |
| `renderer/js/waveform.js` | `this.dbView`, `setDbView()`, the linear branches in `amp01()`/`dbOffset()`/`paintPeaks()`/`paintGuides()`, and the `cb.vzoom` callback (nothing listened to it) | The linear waveform mode was removed earlier; the dB view is always on |
| `renderer/js/app.js` | `wave.setDbView(true)` and the one-time `prefs.dbView` migration | Same |
| `renderer/js/app.js` | `fmtBytes` and `startPlay` in the `createOnline({...})` context | The online module never used them |
| `renderer/js/app.js` | `.type-row` in the sidebar click selector | No such element |
| `renderer/js/layouts.js` | `export function formatClassLabel` | No importers |
| `renderer/js/online.js` | `by` / `by-sa` entries in `LIC_NAMES` and `LIC_TIPS` | Soundfield search only returns `cc0`, `pd` and `epidemic` |
| `renderer/styles.css` | `.chips` (and the rules under it), `.lic.by`, `.lic.by-sa` | No matching elements |

**Keep `LIC_INFO.by` / `by-sa` in `app.js`.** Older entries in `downloads.json` can still carry a CC BY licence, and the player's meta panel uses `LIC_INFO` to show it.

To find dead CSS, list every `.class` and `#id` in `styles.css` and check that each name appears in `index.html` or `renderer/js/*.js`. Expect some false positives: names built in JS strings, such as `lic ${r.license}`.

---

## 4. Checked and left alone

- `package.json` `"exports"`: exposes the engine/layout modules for embedding. It's intentional, not dead.
- `saveEpi()` deleting the old `epClientId`/`epToken`/… fields: a harmless one-way migration.
- `Documents\Soundfield Regions`: drag-a-selection region files pile up over time. Not cleaned automatically, because they may be referenced by DAW sessions.

---

## 5. How it was tested

**Harness:** the app's built-in snapshot harness, run against a *copy* of the user data.

```powershell
$env:SF_USERDATA = "<temp copy of %APPDATA%\Soundfield>"; $env:SF_DOWNLOADS = "<temp dir>"
$env:SF_SNAPSHOT = "<out.png>"; $env:SF_SNAPSHOT_DELAY = "14000"; $env:SF_EVAL = Get-Content <script.js> -Raw
& .\node_modules\electron\dist\electron.exe .
```

**Test details**
- The `SF_EVAL` script uses `window.__sf` (S, engine, wave, applyFilters, openProject, selectIndex…) and `window.api`.
- Mute playback during tests with `__sf.engine.setVolume(-60)`.
- Delete the temp copy afterwards: it contains the encrypted key file.
- Screenshots from the hidden test window can be stale. Check results with values (timings, counts, file timestamps), not pixels.
