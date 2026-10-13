# Soundfield roadmap

Agreed on 2026-10-12. Nothing here has been started yet.

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
| **Your data** | Backups: how often (daily / weekly), where, how many to keep (older ones deleted) · Recently played: how many to remember, "Clear history" |
| **Look & feel** | Startup tab (Library / Online / last used) · Text size / row height · Keyboard shortcuts cheat sheet |
