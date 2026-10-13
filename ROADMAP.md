# Soundfield roadmap

Agreed on 2026-10-12. Nothing here has been started yet. The current release is **0.1.0**, merged on GitHub as PR #3; this update will ship as **0.2.0**.

## Decisions
- **Varispeed is tape-style:** pitch and speed change together.
- **Notes, ratings, markers and recently played share one per-sound store.** Entries follow a sound when it's moved or renamed, using name + size matching like project relink.
- **Preferences move from browser storage to a settings file** in the app data folder, so backups include them.
- **Matched loudness must not slow anything down:**
  - A sound's loudness is measured for free while its waveform is built, since that already reads the whole file.
  - In the background, only short sounds (under about a minute) are measured, at low priority, paused while you play or search.
  - Until a sound is measured, a quick estimate is used.
- **Versioning:** the version and build date show in Settings → About. A **"What's new"** note appears once after each update.
- **Keyboard:** 1–9 already solo channels, so ratings use **Ctrl+1…5** (Ctrl+0 clears). Other new shortcuts are checked against the existing ones before they're picked.

## Build plan
Each phase:
1. Gets built and checked with the test script.
2. Is installed for you to try.
3. Is committed.
4. Adds its user-facing features to `lighthouse-feed.json`, in the same commit, pushed to main. That file is public and feeds the Lighthouse dashboard's suggestions, so it never contains keys, tokens or personal data.
5. Is reflected on the [status dashboard](https://claude.ai/artifact/CGS1fxnHQpkrLqWV3TSF5r).

The phases are merged to GitHub together once you're happy.

1. **Foundation:** a one-command test script; preferences moved to the settings file; version number, About and "What's new".
2. **Safety:** everything in the Safety section below. It comes early because it protects your files and disk.
3. **Settings panel:** everything in the Settings section below, wired to the settings that already exist.
4. **Under the hood:**
   - Chunked decoding for long MP3 / FLAC files.
   - Folder watching.
   - Region-file cleanup.
   - Output device choice.
   - Remembered save folder.
5. **Listening:** tape-style varispeed, loudness measurement with matched-loudness preview, the spectrogram view.
6. **Your sounds:**
   - The per-sound store, with notes, star ratings, markers and recently played.
   - Search support for them, e.g. `rating:4+`.
7. **Backups:** automatic plus manual backup / restore, with old backups deleted automatically.

## Also in this update
- **Undo:** an "Undo" button on the toast after removing sounds from a project, deleting a project, clearing a rating / notes / history, or restoring a backup.
- **Problem log:** errors are written to a small rotating log file in the app data folder. Settings → About gets "Copy problem report", so a bug can be pasted to Claude without guesswork.
- **Speed checks in the test script:** startup time, search time, project open time and memory use are measured on every build. A change that makes something noticeably slower gets flagged before it reaches you.
- **More loudness info:** the integrated LUFS and true peak from the loudness measurement are shown in the player's info panel next to Peak / RMS.
- **Markers in exports:** Materialize / Zip can include a markers list (time + name) next to the sound files.
- **GitHub release:** after this update is merged, the built Soundfield is attached to a GitHub release as a zip, as an off-PC copy of a working build.

## Safety
Anything that copies, moves, deletes or downloads a lot must say how big it is before it starts. Anything that can't fit must be stopped.

**General rules (apply to every item below)**
- **Show the total size and file count before starting**, and check the free space on the destination drive. If it won't fit (plus a 2 GB margin), **block it** and say how much space is missing.
- **Above 10 GB or 5,000 files, ask for a second confirmation** with the size in bold (both limits adjustable in Settings).
- **Long jobs get a Cancel button.** A cancelled copy removes its half-finished folder or zip.

**Projects**
- **Project size stat:** the project banner shows the total size of its sounds ("377 sounds · 4.2 GB · 3 missing"), and so does the sidebar tooltip. The Materialize / Zip dialog shows the size and the free space on the chosen drive.
- **Adding many sounds:** "Add all N to project" adds the total size to its confirmation ("30,738 sounds · 1.1 TB"). Adding is harmless (only references), but it makes a later Materialize obvious.
- **Materializing into a linked library:** warn when the destination is inside a linked library. The copies would show up as duplicates of every sound.

**Recycling (deleting)**
- **Network and NAS drives have no Recycle Bin**, so Windows deletes files there **permanently**. Detect network locations (UNC paths and mapped drives) and say so plainly, with a separate "Delete permanently" confirmation, or refuse.
- **Very large recycles:** the Recycle Bin has a size limit, and files over it may be deleted permanently instead of recycled. Show the total size, and confirm twice above the thresholds (e.g. Ctrl+A → Delete on a whole library).
- **Mass "Keep this one / Recycle extra copies"** in Duplicates already shows sizes. Add the second confirmation above the thresholds.

**Zips**
- **"Extract here" currently overwrites same-named files silently** (tar's default). Never overwrite: keep existing files (tar `-k`) and report what was skipped.
- **Before extracting,** show the uncompressed size and check free space. A zip whose contents are far larger than the zip itself (a "zip bomb") gets a warning.

**Dragging to a DAW**
- **Dragging hundreds of files** (or many GB) into a DAW can freeze it or copy a huge amount. Above 200 files or 5 GB, don't start the drag; suggest Materialize instead.
- **Region export currently loads the whole selection into memory.** A long selection on a 2 GB file could crash Soundfield, so write it in pieces instead, and check free space.

**Online**
- **Large saves:** confirm before saving a sound over 500 MB (some Internet Archive recordings are several GB).
- **Large previews:** some Internet Archive "previews" are the original multi-GB WAV. Above 200 MB, ask before downloading a preview, and show the size in the result row.

**Libraries and duplicates**
- **Linking a huge folder:** warn when linking a whole drive root, the Windows folder or your user profile. They hold millions of non-sound files and would take very long to scan.
- **"Same audio" duplicate search** reads candidate files from disk. Before starting, show roughly how much it will read ("about 380 GB to compare"), and offer Cancel while it runs.

## Planned

### Previewing
- **Pitch / varispeed while previewing:** hear a sound slowed down or sped up before dragging it out, like Soundly.
- **Settings toggle to hide the varispeed control.** Soundfield has no Settings panel yet, so this needs a small one (it can later hold other preferences too).

- **Spectrogram view:** a toggle that shows frequencies instead of the waveform, to spot hum, whine or chirps in a recording. (Asked the Ghost session for spectrogram know-how to reuse.)
- **Matched-loudness preview:** play every sound at the same perceived loudness while auditioning, so quiet and loud sounds don't vanish or blast. Playback only; files are never changed.
- **Markers:** drop named markers on long recordings ("good door slam", "car pass") and jump back to them later. Saved by Soundfield, not written into the audio file.

### Finding sounds
- **Find similar sounds:** list the library sounds closest to the one you're on. It reuses the audio features the category sorting already measures.
- **Your own notes per sound:** stored by Soundfield (your audio files are never changed) and searchable like file names and descriptions.
- **Star ratings (1–5)** alongside Favorites, with a filter such as "4 stars and up".
- **Recently played:** a sidebar list of the last ~100 sounds auditioned.

### Your data
- **Back up / restore Soundfield data:** projects, favorites, notes, ratings, markers and settings in one file (not the audio itself). Old backups are deleted automatically, keeping only the most recent few.

### Under the hood
- **Watch library folders:** new, changed and deleted files show up straight away, instead of only being picked up by the rescan at launch.
- **Clean up drag-to-DAW region files:** the WAVs written to `Documents\Soundfield Regions` when you drag a selection out pile up forever. Add an option to delete them after N days, because DAW sessions may still use recent ones.
- **Decode long MP3 / FLAC files in chunks:** compressed files are currently decoded whole into memory (a 25-minute MP3 takes about 600 MB of RAM). Decode them in pieces instead.

## Decided against
- **Saving waveforms (peaks) to disk:** not wanted for now.

## Spectrogram notes (from the Ghost session's JUCE spectral editor)
Source to adapt: `C:\Dev\SpectralEditor\Source`. `SpectrogramData.cpp` does the analysis; `SpectralView.cpp` (`rebuildPalette`, `rebuildImage`) does the drawing.

**Analysis**
- FFT 2048, periodic Hann window, hop 256 (8× overlap). Offer a 512 / 1024 / 2048 / 4096 choice; 1024 suits sound-effect transients.
- Keep the hop at or below N/4: hop matters more than FFT size for how sharp transients look.
- Analyse each channel separately, one lane per channel.
- Magnitude is `|X[k]| · 4/N`, so a full-scale sine reads 0 dBFS (check this with a full-scale sine). Then take `20·log10` with a floor.
- Store levels as uint8 over −160…0 dB: `(dB + 160) · 255/160`. That's 1 byte per bin per frame.
- Run the analysis in the existing Node peaks worker, in chunks, and transfer an ArrayBuffer to the renderer.
- Work out bin ↔ Hz from each file's own sample rate (96k / 192k files exist).

**Display**
- The display range is separate from what's stored: colour = `gradient(1 + dB/range)`, clamped to 0…1.
- Default range is 130 dB, with a slider from 60 to 160. The waveform's −40 dB floor is far too shallow here: quiet detail lives at −80…−120.
- Build a 256-entry lookup table (level → RGBA) and rebuild it only when the range or palette changes.
- Audition-like palette (positions 0…1):

  | Position | Colour |
  |---|---|
  | 0 | black |
  | 0.12 | #14082f |
  | 0.32 | #3b1475 |
  | 0.50 | #8e1a8e |
  | 0.64 | #d8245f |
  | 0.78 | #ff7400 |
  | 0.90 | #ffd000 |
  | 1.0 | white |

- Frequency scales: linear (Audition-style) and log (20 Hz to Nyquist). Log is probably the best default for sound effects. Skip mel.

**Rendering (CPU, no WebGL needed)**
- Keep one view-sized ImageData per lane and redraw it only when the view, zoom or data changes. The playhead and selection are drawn on top.
- Pixel columns: **max-pool** the frames each column covers, never average, or clicks vanish when zoomed out.
- Pixel rows: precompute the bin range for each row and max-pool those bins too.
- If wide zooms on long files get slow, add a mip pyramid (max-pooled 2× in time).

**Pitfalls**
- A floor or range that's too shallow was the #1 complaint.
- Averaging instead of max-pooling hides transients.
- A window / scale mismatch puts 0 dBFS in the wrong place.
- Assuming 44.1k or 48k gives the wrong frequency axis.
- Analysing on the UI thread stalls the app.

## Ideas not taken (for now)
- Reverse preview
- Drag options (fades, normalize, mono fold-down, format conversion on drag)
- Smarter search (synonyms, typo tolerance)

## Settings panel
Every setting below goes in. Layout rules:
- A section list on the left, with only one section shown at a time.
- Each setting gets a one-line, plain-English description underneath. Advanced details go in a hover tooltip, not more text.
- A search box at the top to filter settings.
- Changes apply immediately (no Save button), and each section has a "Reset to defaults".
- Every value is remembered until you change it again.

| Section | Settings |
|---|---|
| **Playback** | Output device (audio interface / speakers, separate from Windows' default) · Single- or double-click to play · Show the varispeed control · Matched-loudness preview on/off and target (e.g. −23 / −16 LUFS) |
| **Waveform & spectrogram** | Peak warning level (red at −1 dBFS now) · dB scale floor (−40 default; optional −60) · Spectrogram level range (default **130 dB**, slider 60–160, **remembered exactly where you leave it**) · Spectrogram detail (FFT size), colour scheme, frequency scale (log / linear) |
| **Saving & files** | Default save folder for Soundfield search (remembered across launches) · Write Credits.txt on/off · Drag-to-DAW region folder and how many days to keep region files · Preview cache size (300 MB now) + "Clear cache now" |
| **Libraries** | Watch folders for changes on/off · Background category sorting on/off · Manage excluded duplicate folders |
| **Accounts** | Freesound key/account and Epidemic keys, moved here from the Online top bar |
| **Safety** | Size that needs a second confirmation (10 GB default) · File count that needs it (5,000) · Drag-to-DAW limit (200 files / 5 GB) · Ask before previews over (200 MB) · Network-drive deletes: refuse / ask |
| **Your data** | Backups: how often (daily / weekly), where, how many to keep (older ones deleted) · Recently played: how many to remember, "Clear history" |
| **Look & feel** | Startup tab (Library / Online / last used) · Text size / row height · Keyboard shortcuts cheat sheet |
