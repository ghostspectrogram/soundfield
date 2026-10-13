# Soundfield

A fast sound-effects library explorer built for surround and immersive audio.

Libraries are linked in place (nothing is copied), and every file shows a per-channel waveform. Surround, Atmos-style beds and ambisonics are monitored in stereo, binaural (HRTF) or discrete. Selections drag straight into your DAW.

## Running from source
Requires [Node.js](https://nodejs.org) 20+ on Windows (macOS/Linux should work but are untested).

```bash
git clone https://github.com/ghostspectrogram/soundfield.git
cd soundfield
npm install
npm start
```

If `npm start` says Electron failed to install, newer npm versions sometimes skip Electron's download step. Run `node node_modules/electron/install.js` once, then `npm start` again.

### Standalone app (Windows)
`npm run build` packages `Soundfield.exe` into `dist/`, installs it to `%LOCALAPPDATA%\Programs\Soundfield`, and points the Start menu shortcut at it. Close Soundfield before rebuilding (Windows locks a running exe), or use `npm run build -- --wait` to install as soon as it closes. Libraries, projects and settings (`settings.json`) live in `%APPDATA%\Soundfield`, so they carry over between builds. `npm run build -- --no-install` only packages.

Each build records its version, build time and commit; click the **Soundfield** name at the top left to see them, along with the release notes (also shown once after each update). Release notes live in `renderer/js/whats-new.js`; bump `version` in `package.json` and add an entry there for every release.

### Tests
- `npm test` generates a small test library (tones with known levels in mono, stereo, 5.1, ambisonic, float, AIFF, a zip and a duplicate). It runs Soundfield hidden against it and checks:
  - scanning, layouts and search;
  - exact peak levels;
  - playback while switching sounds quickly;
  - projects and duplicates;
  - that preferences survive a restart;
  - the safety checks, with Windows dialogs answered by the test script.
- `npm test -- --perf` times startup, filtering, search and project views on a *copy* of your real library index; no audio is read. Add `--save-baseline` to remember the result, and later runs flag anything more than 25% slower. The baseline is per machine and not committed.
- Neither touches your own data.

The app icon lives in `build/icon.ico` / `build/icon.png`. It's drawn by `tools/make-icon.js`; run `npm run icon` to regenerate it after tweaking the design.

## Project layout
| Path | What it is |
|---|---|
| `main.js`, `preload.js` | Electron main process (libraries, scanning, IPC, drag-out, recycle) and the bridge the UI talks through |
| `lib/probe.js` | Header-only probing of WAV/BWF/RF64, AIFF/AIFC, FLAC, MP3, OGG/Opus and M4A: channels, mask, iXML track names, BWF description |
| `lib/scan-worker.js`, `lib/peaks-worker.mjs`, `lib/analyze-worker.mjs`, `lib/dupes-worker.js` | Background workers: library scan, waveform peaks, listening-based categorising, duplicate detection |
| `lib/region.js`, `lib/zip.js`, `lib/store.js` | Selection-to-WAV export (keeps channel mask + metadata), zip counting / extraction, JSON persistence |
| `shared/pcm.mjs` | PCM decoding (8/16/24/32-bit int, 32/64-bit float, LE/BE) and incremental min/max/RMS peak building |
| `shared/loudness.mjs` | BS.1770 loudness meter: K-weighting, gated integrated LUFS, true peak |
| `shared/spectro.mjs`, `renderer/js/spectro.js`, `renderer/js/spectro-worker.js` | Spectrogram FFTs (max-pooled columns, one byte per level) and the worker that computes them |
| `shared/categorize.mjs` | UCS / Epidemic-style categories from names and metadata, plus audio feature analysis |
| `renderer/js/layouts.js` | Channel-layout detection and monitoring matrices: Lo/Ro downmix, binaural virtual speakers, AmbiX/FuMa decoding up to 3rd order |
| `renderer/js/engine.js`, `renderer/worklet/player.js` | Streaming multichannel playback engine (AudioWorklet), one AudioContext per sample rate, optional output device |
| `renderer/js/sources.js`, `renderer/js/chunked.js` | Audio sources: PCM streamed off disk; long MP3 / FLAC decoded about 10 s at a time (frame index + small stand-alone pieces); everything else decoded whole |
| `renderer/js/waveform.js`, `renderer/js/speakers.js` | Multichannel waveform view and top-down speaker / ambisonic intensity map |
| `renderer/js/app.js` | The explorer UI |
| `lib/backup.js` | Backups of Soundfield's own data: create, list, restore, which automatic ones to clean up |
| `lib/teamsfx.js` | Team SFX client: index sync with cursor, local search, downloads and uploads through the Lighthouse service |
| `renderer/js/search.js` | Search parsing, synonyms (built-in list), typo tolerance, `rating:` / `has:` filters |
| `renderer/js/whats-new.js` | Release notes for About and the "What's new" note |
| `tools/build.js`, `tools/test.js` | Standalone build + install, and the test / speed runs (`tools/fixtures.js` makes the test library) |

## Using it in another project (e.g. a DAW)
Add it as a dependency straight from GitHub:

```bash
npm install github:ghostspectrogram/soundfield
```

Or add it as a git submodule (`git submodule add https://github.com/ghostspectrogram/soundfield.git`). Then import only the parts you need:

```js
// Node / Electron main process (CommonJS)
const { probe } = require('soundfield/probe');        // fast header info for any audio file
const { writeRegionSync } = require('soundfield/region');

// ES modules (Node for the .mjs files, or any bundler / browser)
import { decodePcm, PeakBuilder, bucketFor } from 'soundfield/pcm';
import { metaCategory, TYPE_LABELS } from 'soundfield/categorize';
import { LoudnessMeter } from 'soundfield/loudness'; // LUFS + true peak: new LoudnessMeter(sr, ch).push(planar, n) … .result()
import { SpectroBuilder, planWindows } from 'soundfield/spectro';

// Browser-side modules (use a bundler such as Vite or webpack)
import { detectLayout, buildMonitor } from 'soundfield/layouts';
import { Engine } from 'soundfield/engine';
```

- **Layouts:** `detectLayout(record)` takes `{ ch, mask, tn, rel }` (as returned by `probe`: `trackNames` → `tn`) and returns the channel layout. `buildMonitor(layout, 'stereo' | 'binaural' | 'discrete', { mute, solo, lfe })` returns the gain matrix and virtual speaker positions.
- **Engine:** `new Engine({ workletUrl })` takes the URL your app serves `soundfield/worklet/player.js` from. It plays *sources* (`renderer/js/sources.js`), which read audio through a small host API on `window.api`:

  | Method | Returns |
  |---|---|
  | `readRange(path, offset, length)` | `Uint8Array` of raw bytes |
  | `readFile(path)` | `Uint8Array` of the whole file (compressed formats) |
  | `peaks({ jobId, path, fmt, bucket })` | peak data (see `lib/peaks-worker.mjs`) |
  | `on('peaks:progress', cb)` | unsubscribe function |

  `preload.js` + the matching handlers in `main.js` are a complete reference implementation.

## License
No license has been granted: all rights reserved. You're welcome to read the code; reuse requires permission from the author.

## Settings
- **Opening it:** click the gear at the top right, or press **Ctrl+,**.
- **Layout:** one section at a time, with a plain description under every setting and a search box at the top. Changes apply immediately and are kept in `settings.json`, and every section has *Reset to defaults*.

| Section | What's there |
|---|---|
| Playback | Output device, single-click play, arrow-key auto-play, loop, monitor mode, LFE |
| Waveform | Level scale range (−40 or −60 dBFS), peak warning level |
| Saving & files | Default save folder for Soundfield search, Credits.txt on/off, folder for dragged selections and how long to keep them, preview cache size + *Clear now* |
| Libraries | Folder watching on/off, background sorting on/off, folders left out of duplicate searches |
| Accounts | Freesound and Epidemic Sound setup |
| Safety | The size / file-count limits, drag limits, preview and save limits, network-drive deletes |
| Your data | The data folder |
| Look & feel | Startup tab, interface size, list row height, keyboard shortcuts |
| About | Version, release notes, **Copy problem report** (version, Windows version and recent errors from `logs\soundfield.log`) |

## Safety
Anything that copies, deletes or downloads a lot says how big it is before it starts.

**Free space and limits**
- Materialize, Zip, Extract, region drags and online saves check the destination drive's free space, keeping 2 GB spare. If a job won't fit, it's refused, with the amount you'd need to free up.
- Above 10 GB or 5,000 files, a second confirmation is asked. These limits live in `shared/safety.json` and become adjustable in Settings.
- Materialize / Zip can be cancelled from the status bar while they run. A cancelled or failed one removes its half-finished folder or zip.

**Specific protections**
- Materializing into one of your own libraries warns first, because the copies would be indexed as duplicates.
- Recycling shows the total size. Network and USB drives have no Recycle Bin, so deleting there is permanent: Soundfield says so in a separate warning. Very large batches ask twice, because Windows may permanently delete files that don't fit in the Recycle Bin.
- Extracting a zip never overwrites existing files. A zip that unpacks to more than 20× its own size (and over 1 GB) gets a warning.
- Dragging more than 200 files or 5 GB into a DAW is refused with a hint to use Materialize instead. Selections are written to disk in pieces, never loaded whole.
- Online results show their size. Saves over 500 MB, and previews over 200 MB (some Internet Archive "previews" are the full original), ask first. Big previews are never downloaded in the background.
- Linking a whole drive, the Windows folder, Program Files, an app-data folder or your user folder asks first. The "same audio" duplicate search says how much it may read from disk, and can be cancelled.

## Libraries
- The total size of all your libraries is shown next to *Libraries*; hover a library for its own sound count and size.
- Click **+** next to *Libraries* to link a folder. Files are never copied or moved; only audio files are indexed (WAV/BWF/RF64, AIFF/AIFC, FLAC, MP3, OGG/Opus, M4A).
- Library folders are watched: sounds added, renamed or deleted show up within a few seconds. On launch, libraries also quietly rescan in the background. Only new or changed files are re-read.
- Long MP3 and FLAC files (2 minutes and up) are decoded about 10 seconds at a time, so even hour-long recordings use little memory.
- Right-click a library to rescan it, remove it (your files stay untouched), or set how its 4-channel files should be read (Quad, AmbiX, or FuMa).
- Zips that contain audio are listed. Right-click one, or use the buttons in the preview panel, to **Extract here** or **Extract to "<zip name>"**. The library then rescans automatically.

## Projects
Virtual project folders: a project holds *references* to sounds. Nothing is moved or copied, and one sound can be in any number of projects.
- **Create:** click **+** next to *Projects* in the sidebar.
- **Add sounds:** right-click → *Add to project ▸*; drag sounds from the list onto a project; press **P** to add the sound you're previewing to the project you used last; or right-click a project → *Add all listed sounds* (handy after a search or filter).
- **Open:** click a project to list its sounds. Sounds that belong to a project show a ▣ badge elsewhere in the app.
- **Missing files:** if an original is moved, renamed or deleted, it shows as **missing**. **Relink missing** finds it again in your libraries by name and size.
- **Zip…** packs the project into one .zip in the background. Audio is stored uncompressed (fast; sound files barely compress), same-named files become `name (2).wav`, missing files are skipped and listed in a report, and a list of original locations can be included.
- **Materialize…** copies the project into a real folder named after it, and verifies each copy. Originals are never moved or deleted. You can choose all-in-one-folder or keep library folders, and optionally point the project at the new copies (the new folder is then added as a library).
- **Manage:** right-click a project to rename, relink or delete it. Deleting a project never touches the sounds.
- **Finding exports again:** Soundfield remembers where each project was materialized or zipped. Right-click the project → *Show materialized folder in Explorer* (or *Show zip in Explorer*), or use **Show exports ▾** in the project's banner. *All exports* lists earlier ones.

## Online
Click **Online** (next to *Library* at the top). It has two modes, switched under the search bar:
- **Soundfield search** shows only sounds you can preview and save straight into Soundfield, and only attribution-free ones (CC0 and public domain) that you can use in anything, including paid and commercial work, with no credit needed.
- **Sound effects / Music** (next to the mode switch): *Music* searches the same free sites for CC0 and public-domain music instead. Freesound results are limited to its Music category (with a free Freesound key; without one, results are kept to music-looking titles and tags), Wikimedia Commons to recordings in music categories, and Internet Archive to music uploads. Results get **Key** and **BPM** columns (sortable) from their titles and tags, or from Freesound's own analysis (marked ≈), plus BPM and key filters. Saved music goes into `Soundfield DownloadsMusic<Source>` and is always sorted as Musical. Epidemic Sound and Team SFX are sound effects only here.
- **Website search** lists sound sites, grouped as free, subscription and not-for-commercial-work, each with a badge for its terms. Clicking one opens your search on that site in your browser (signed in as you).

### Soundfield search
- **Sources:** Freesound, Wikimedia Commons and Internet Archive, through their official search APIs (pick them under **Sources ▾**). Type a search and press **Enter**: each site's results appear as soon as it answers (the status line says which are still searching), and more load as you scroll. Internet Archive results are mostly long field recordings and soundscapes (e.g. Radio Aporee) plus some sound packs. A pack's files are listed individually, with the pack name shown in the player. Its licences are what each uploader declared; only CC0 / public-domain uploads are shown.
- **Licences:** only CC0 and public-domain sounds are shown. Sounds that need credit (CC BY), share-alike, non-commercial or no-derivatives sounds are never shown.
- **File type:** the *File type* menu limits results to WAV, AIFF, FLAC, MP3 and/or OGG (*Lossless only* = WAV, AIFF, FLAC). It applies to the original file; without a connected Freesound account, Freesound saves are MP3 previews. Click a column header (e.g. *Format*) to sort the results.
- **Preview:** click a result to see its waveform; double-click (or Enter) to play. Big Wikimedia Commons WAV / FLAC files are previewed through their MP3 copy, so they start fast; **Save** still gets the original. Previews are cached in the app's own folder, not your libraries (the most recent 300 files / 300 MB).
- **Save** (or `S`, or right-click → *Save*) downloads it to `Documents\Soundfield Downloads\<Source>`, which is added as the *Online downloads* library. Each save is recorded in `Credits.txt` there, with the creator, link and licence, so you always know where a sound came from. *Copy credit line* copies that line for one sound. Dragging a result to your DAW saves it first.
- **Save to:** the **Save to** button (right of the mode switch) shows where **Save** puts sounds this session, and you can change it at any time: *Choose folder…*, a recent folder, or back to *Soundfield Downloads (default)*. You can also right-click any folder under Libraries → *Save Soundfield search downloads here*. Sounds go straight into the chosen folder, with its own `Credits.txt`, and the folder is added as a library if it isn't in one already. Each launch starts at the default again. Saving a sound you already saved elsewhere makes another copy in the current folder.
- **Epidemic Sound (your subscription):** click **Epidemic** in the top bar and paste your own *Epidemic account key* (epidemicsound.com → Account → API keys). It's stored encrypted on this PC only. Search, quick previews and saves all go through Epidemic's official MCP server with that key, so they're covered by your subscription and nothing is counted. Saves are WAV. Each person must use their own account key; never share yours. If saving says your account isn't allowed to download, the key belongs to an Epidemic account without a plan that includes sound-effect downloads. A *developer key* from the [Developer Portal](https://developers.epidemicsound.com/) is optional: it's only used for searching when there's no account key, and never for listening or saving, because on the free developer plan every such call counts toward a 50-download limit with no commercial licence. Epidemic sounds are excluded from Soundfield's audio analysis, because their licence forbids data mining. Their names already give their category. Turn Epidemic on or off under **Sources ▾**.
- **Freesound key and account (free):** click **Freesound** in the top bar. Without a key, Freesound is searched through Openverse (an older index, about 200 searches a day). With a free API key, search uses Freesound directly. Connecting your Freesound account as well makes **Save** download the original WAV / AIFF / FLAC instead of the MP3 preview. The key and account tokens are stored encrypted with your Windows account.

### Team SFX
The team's shared sound library (the SFX folder in the team Dropbox), reached only through the Lighthouse service; Soundfield never talks to Dropbox.
- **Setup:** make your own Soundfield key at app.lighthouseworkstation.com → Account → Soundfield key, then paste it in Settings → Accounts → Team SFX (or the button in the Online tab). It's stored encrypted on this PC and only sent to `api.lighthouseworkstation.com`.
- **Search:** tick **Team SFX** under Sources. Soundfield keeps a copy of the index (`teamsfx.json`) and refreshes what changed with its cursor when you search, at most every 3 minutes (the service allows one index request a minute).
- **Listen / Save:** a file is downloaded only when you listen to it or save it (never in advance), cached by id + revision; Save reuses the file you just heard. Each sound shows its folder's licence and credits (from CREDITS.txt), also written to Credits.txt when saved. Team sounds licensed through Epidemic are left out of background listening, like Epidemic downloads.
- **Add sounds:** right-click library sounds → **Add to Team SFX…**, pick a folder (e.g. `Drop here/Rain pack`) and optional credits (that folder's CREDITS.txt). Up to 150 MB per file and 300 files a day per key; same-named files are kept as "name (2)".

### Website search
Sites that don't let other apps search them: Freesound and Wikimedia Commons (their full catalogues, every licence), Pixabay, Mixkit, Zapsplat, Uppbeat, SoundBible, Sound Gator, 99Sounds, the Sonniss GDC bundles, Epidemic Sound, Artlist, Envato Elements, Storyblocks, Soundsnap and BBC Sound Effects. Type a search, then click a site to open it there. Hover a site for its licence terms. BBC Sound Effects are for personal / educational use only. Sounds you download from these sites can be linked as a library like any other folder.

## Your sounds: ratings, notes, markers
Kept by Soundfield in `sounds.json` in the data folder; your audio files are never changed. Each entry remembers the file's name and size, so it follows a file moved to another folder (when exactly one file matches).
- **Ratings (1–5 stars):** Ctrl+1 … 5 rates the selected sound(s), Ctrl+0 clears; or click the stars in the **Rating** column or the info panel. **Any rating** in the top bar filters (★★★★ and up…).
- **Notes:** type in the box under the sound's info. Notes are searched like file names.
- **Markers:** `K` drops one at the playhead (or the selection start). Name it in the info panel; click its flag on the ruler to play from there, right-click to rename or delete. Materialize / Zip can add `_Markers.txt` (file, time, name).
- **Recently played:** the sidebar lists the last 100 sounds you played, newest first (Settings → Your data changes the number; right-click to clear).
- **Find similar sounds:** right-click a sound (or the button in the info panel). The closest sounds are listed by the features the background listening measures (loudness over time, noisiness, onsets, pitch…), plus category, name and length. Sounds not measured yet are compared by name, category and length.
- **Undo:** removing sounds from a project, deleting a project, clearing a rating, notes or Recently played, deleting a marker and hiding a folder show a toast with **Undo** (or Ctrl+Z while it shows).

## Backups
Settings → Your data. A backup is one small file (`Soundfield backup 2026-10-13 0830.sfbackup`, gzipped JSON) holding projects, favorites, your notes / ratings / markers / recently played, settings, libraries, category and layout choices, and where downloaded sounds came from. Not included: your sound files, caches (rebuilt automatically) and account keys.
- **Automatic:** every day (or week, or never) while Soundfield is running, into `Documents\Soundfield Backups` or a folder you pick. Only the newest 10 automatic backups are kept (adjustable); older ones go to the Recycle Bin. Backups you make with **Back up now** are never removed.
- **Restore:** pick one from the list or a file. Soundfield shows what it holds, saves the current state as a "before restore" backup, restores and restarts, then offers **Undo**.

## Search
- Words narrow the list; `-word` excludes; `"exact phrase"` matches a phrase.
- **Synonyms:** "gun" also finds rifle, pistol, gunshot… from a built-in sound-design list, listed after the exact matches. Quotes (`"gun"`) search for just that word. Add your own groups in Settings → Search.
- **Typos:** when a search finds nothing, close spellings that exist in your library are tried ("explsion" → explosion).
- **Your fields:** `rating:4+`, `rating:3`, `rating:2-`, `rating:0` (not rated), `has:notes`, `has:markers`, `has:rating`.

## Sidebar
- **Hide a folder from All sounds:** click the eye beside a folder (or library) under Libraries, or right-click it. Its sounds stay out of All sounds, its search, the category counts and Find similar, but are still listed when you open that folder. Settings → Libraries lists hidden folders.
- **Resize:** drag the bar just above **Libraries** up or down to make Categories shorter or taller. Double-click the bar to reset.
- **Collapse:** click the **Categories** or **Libraries** header (▾) to collapse that section; click again to expand. When one is collapsed, the other uses the space.
- Sizes and collapsed sections are remembered.

## Folder view
Click **Folders** in the top bar to browse like Explorer:
- **Folder rows:** the list shows the current folder's subfolders (with a sound count), then only the sounds directly in that folder. **Double-click** a folder, or press **Enter**, to open it.
- **Going back up:** the path bar (`All libraries › Library › Folder`) jumps back up, and so do **↑ Up** and **Backspace**. Clicking a folder in the sidebar tree opens it here too.
- **Search:** typing a search, or using a filter or category, shows matches from every folder inside the current one.
- **Turning it off:** click **Folders** again for the flat list of every sound. Duplicates and Favorites are always flat lists.

## Columns
Like Windows Explorer: drag the divider at the right edge of a column header to resize it. Columns to the right shift over, and the list scrolls sideways when they don't fit. **Double-click** a divider to size that column to its longest entry. **Right-click** the header for *Size column to fit*, *Size all columns to fit* and *Reset column widths*. Widths are remembered between sessions.

## Categories
Sounds are sorted into the top-level categories Epidemic Sound uses (the UCS standard: Air, Aircraft, Alarms … Wings, Wood, 77 in all; no Farts), plus **Background**, **Room tone** and **Voice**. Epidemic's *Ambience* is Background and *Voices* is Voice. The category is decided by, in order:
1. **Your choice.** Right-click → **Category** → pick one. This always wins (✎ marks it). *Automatic* undoes it.
2. **The file name, then its description, then its folders.** UCS CatIDs (`DOORWood_…`, `EXPLReal_…`, `AMBRoom_…`) map directly. Otherwise keywords are matched in a deliberate order, so *Car Door* → Vehicles, *Wooden Door* → Doors, *Laser Gun* → Lasers, *Nail Gun* → Tools, *Tap Running* → Water, *Tire Scream* → Vehicles.
3. **Listening.** Files whose names say nothing are analysed in the background, using up to ~9 s of audio per file and caching the result. Listening can recognise Room tone, Background, Voice, Footsteps and Musical. Musical needs a steady beat and an even level; being tonal alone isn't enough (most recordings are), so dialogue, drones and tones aren't called music. Other one-shots can't be told apart by ear (a door vs. a metal hit), so they stay **Unsorted** for you to set. MP3, FLAC, OGG and M4A files are sorted by name only.

Folder names count closest folder first, so a *Doors* folder inside a *Voiceover* folder holds doors. Epidemic music saved as `ES_<title> - <artist>` is Musical; instrument words (*piano*, *choir*, *cymbal*…) only decide when nothing more specific does, so a *Cymbal Whoosh* is a whoosh.

**Music: Key and BPM.** With **Musical** picked (and only then), the list gets **Key** and **BPM** columns (sortable) and *BPM* / *Key* filters at the top: type `120` (give or take 2), `90-110` or `140+`. They come from the name, description or folders (`Loop Am 95bpm`, `F#min 110bpm`, `B Minor`), or from what the sound was saved with, or by ear: music files are listened to for 30 s from the middle (marked ≈). A tempo is only guessed when there's a beat, and a key only when the music clearly has one. Epidemic files (`ES_…`) and folders whose `CREDITS.txt` mentions Epidemic are left out of this background listening; they still play and show waveforms as usual.

The sidebar lists the categories that have sounds. Click one to filter (Ctrl-click to combine). The **Category** column is sortable, and typing a category name in search also works. Right-click a category → **Add all N to project ▸** to put every sound in it into a project (or a new one). When a search or filter is narrowing the list, **Add the N listed to project** adds just those.

## Duplicates
- Click **Duplicates** in the sidebar, then choose how to search:
  - **Same audio**: identical sound. Only the audio data is compared, so renamed copies and copies with different BWF/iXML metadata are still caught. Only files with the same format and length are read, so it stays fast.
  - **Same name**: files sharing a name, ignoring upper/lower case and extension. Instant, but same-named files can be different sounds.
- **Check again** re-runs the same search; **New search…** takes you back to the choice.
- **Recycle extra copies (N · size):** in one go, keeps the first sound listed in every duplicate group and moves the other listed copies to the Recycle Bin. It only acts on what's currently listed: excluded folders and anything hidden by a filter or category are never touched. You confirm first, and big batches show progress in the sidebar. In *Same name* mode the confirmation warns that same-named files can be different sounds.
- **Excluding folders:** right-click any sound → *Exclude contents of this sound's folder from duplicates*. You can also pick a level higher with *Exclude a parent folder ▸*, or right-click a folder under Libraries → *Exclude from duplicate search*. Everything inside is ignored by both searches.
- **Re-including:** excluded folders are listed as chips under the Duplicates banner; click **✕** to re-include one. Right-clicking a sound in an excluded folder offers *Re-include this sound's folder*, and in Duplicates every sound's menu has an *Excluded folders ▸* submenu. Excluded folders show ⊘ in the tree. Changes take effect instantly and are remembered. *Keep this one* never recycles files in excluded folders.
- Copies are grouped together, with the groups that free the most space first. Right-click a file and choose **Keep this one, recycle the other copies**, or **Move to Recycle Bin**. You confirm each time, and files go to the Recycle Bin rather than being deleted.

## Surround / immersive
- The layout is detected from the WAV channel mask, iXML track names (so film-order L C R Ls Rs LFE files and M/S pairs work), ambisonic file names (ambiX / FOA / HOA / 3OA…), and finally the channel count. You can override it per file with the **Layout** menu.
- **Monitor** options:
  - **Stereo (Lo/Ro)**: a standard downmix. Ambisonics are heard through virtual cardioid mics, and M/S is decoded.
  - **Binaural (HRTF)**: every channel becomes a virtual speaker around your head, including heights. Ambisonics are decoded to a virtual speaker sphere.
  - **Discrete outputs**: sends channel *n* to device output *n*, for multichannel interfaces.
- **LFE** toggles whether the LFE channel is included in the stereo and binaural monitor modes.
- Each channel lane has Mute/Solo buttons and a meter. Click a speaker in the map to solo it. For ambisonic files, the map shows the direction the energy is coming from.

## Waveform
- **How loud is it?** The **dB** column left of the waveform is a level scale from 0 dBFS (lane edge) to −40 dBFS (centre line; −60 in Settings → Waveform), and ▸ marks each channel's peak. Each lane label shows that channel's peak (red at −1 dB or louder), and the info panel shows the file's **Peak** and **RMS** (average level) in dBFS. All of it is measured as soon as the waveform loads, before you play anything.
- **Even scale:** the waveform is drawn on that −40 … 0 dB scale, so every 5 dB is the same distance and quiet detail stays visible. Labels go every 5 dB when the lanes are tall enough, otherwise every 10 or 20 dB. Alt+wheel still zooms vertically, and the scale follows.
- **Loudness:** the info panel also shows **Loudness** (integrated LUFS, EBU R128 / BS.1770) and **True peak** (dBTP, 4× oversampled). They're measured in the same pass as the waveform; short sounds are measured in the background while nothing plays, and results are kept in `loudness.json`.
- **MATCH** (`M`) plays every sound at the same loudness (default −20 LUFS, Settings → Playback), turning quiet sounds up only as far as −1 dBTP. Only the preview changes, never the file.
- **Varispeed** (`[` / `]`, ±12 semitones): tape-style, so speed and pitch move together. Double-click the slider to reset. Every launch starts at normal speed, and dragged files keep their original speed.
- **SPECTRO** (`V`) swaps the waveform for a spectrogram: an overview of the whole sound, then a sharper picture of the visible part when you zoom in. Each column keeps the loudest level in it, so short clicks still show. The **level range** slider (60–160 dB, default 130) is remembered; frequency scale, detail (FFT size) and colours are under Settings → Waveform. Computed in a background worker.
- Click to play from that point. Drag to select, and the selection plays.
- Drag the selection, the **Drag to DAW** handle, or any list row into your DAW. Selections are written as new WAVs (keeping the channel layout and metadata) in `Documents\Soundfield Regions`.
- Wheel: zoom · Shift+wheel: scroll · Alt+wheel: vertical zoom · Double-click / `Z`: zoom to fit.

## Keys
| Key | Action |
|---|---|
| ↑ / ↓, PgUp / PgDn | Previous / next sound (auto-plays when AUTO is on) |
| Space | Play / stop |
| Enter | Play from start |
| ← / → (Shift = 5 s) | Jump 1 s |
| `-` / `=` | Preview volume −/+ 1 dB (also mouse wheel over the slider) |
| `1`–`9` / `0` | Solo channel *n* / clear solos |
| `L` / `A` / `B` | Loop / auto-play / toggle binaural |
| `M` | Matched loudness on / off |
| `[` / `]` | Varispeed down / up a semitone |
| `V` | Waveform / spectrogram |
| `F` | Favorite |
| Ctrl+F or `/` | Search (`-word` excludes, `"exact phrase"` matches a phrase, `rating:4+`, `has:notes`) |
| Ctrl+1 … 5 / Ctrl+0 | Rate the selected sound(s) / clear the rating |
| `K` | Drop a marker at the playhead |
| Ctrl+Z | Undo, while a toast offers it |
| Shift-click / Shift+↑↓ | Select every sound between the last one clicked and this one |
| Ctrl-click | Add a sound to the selection, or remove it |
| Ctrl+A | Select all listed sounds (Esc clears the selection) |
| Delete | Move the selected sound(s) to the Recycle Bin (you confirm first; restorable) |
| Esc | Clear selection, then stop |
| F12 | Developer tools |
