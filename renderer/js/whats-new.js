// Release notes shown once after an update ("What's new") and in About. Newest first.
// Each version's entry lists what someone using Soundfield will notice, in plain words.
export const RELEASES = [
  {
    version: '0.2.0-beta.9',
    date: '2026-10-13',
    items: [
      'Far fewer sounds wrongly sorted as Musical. Dialogue recordings, tones, drones and rumbles aren’t called music any more; music now needs a steady beat. Your existing sounds are re-sorted in the background.',
      'Better sorting by name: Epidemic music (ES_… - artist) is Musical, folder names count closest folder first (so a Doors folder inside a Voiceover folder holds doors), and a Cymbal Whoosh is a whoosh.',
      'Music gets Key and BPM: pick Musical in the sidebar to see Key and BPM columns (click to sort) and BPM / Key filters at the top. They come from file names, or by ear for music files (marked ≈).',
      'Online → Music: search Freesound, Wikimedia Commons and Internet Archive for CC0 / public-domain music, with Key and BPM columns and filters. Saved music goes into a Music folder and is sorted as Musical.',
      'The total size of your libraries is shown next to Libraries (hover a library for its own size).',
      'Epidemic files (ES_…) and folders whose CREDITS.txt mentions Epidemic are left out of background sorting by ear. They still play and show their waveforms as usual.',
    ],
  },
  {
    version: '0.2.0-beta.8',
    date: '2026-10-13',
    items: [
      'Backups: projects, favorites, your notes, ratings and markers, settings and libraries are backed up every day into Documents\\Soundfield Backups (Settings → Your data). Only the newest 10 automatic backups are kept; older ones go to the Recycle Bin. Your sound files and account keys aren’t included.',
      'Back up now and Restore are under Settings → Your data. Restoring shows what the backup holds, saves the current state first, restarts Soundfield, and offers Undo.',
      'Fixed: after listening to an online sound, the notes and markers panel could disappear until restart.',
      'Fixed: Settings text showing in a typewriter font inside boxes (since beta.6).',
    ],
  },
  {
    version: '0.2.0-beta.7',
    date: '2026-10-13',
    items: [
      'Team SFX: the team’s shared sound library (through Lighthouse) is a source in the Online tab. Search it, listen, and Save like any other site; each sound shows its folder’s licence and credits.',
      'Add sounds to Team SFX: right-click sounds in your library → Add to Team SFX…, pick a folder there and optional credits.',
      'Set it up with your own Soundfield key: Settings → Accounts → Team SFX (make the key at app.lighthouseworkstation.com → Account → Soundfield key).',
    ],
  },
  {
    version: '0.2.0-beta.6',
    date: '2026-10-13',
    items: [
      'Star ratings: Ctrl+1 … 5 rates the selected sounds (Ctrl+0 clears), or click the stars in the new Rating column. “Any rating” at the top filters to 4 stars and up, and so on.',
      'Your own notes for each sound, under the sound’s info on the right. They’re searchable, and never written into the file.',
      'Markers: press K to drop one at the playhead, name it on the right, click its flag to play from there. Materialize and Zip can include a list of them.',
      'Recently played in the sidebar: the last 100 sounds you played (right-click to clear).',
      'Smarter search: “gun” also finds rifle, pistol, gunshot… (listed after exact matches), and a search with a small typo (“explsion”) still finds what you meant. Quotes search for just that word. Also rating:4+, has:notes and has:markers. Add your own synonyms in Settings → Search.',
      'Find similar sounds (right-click a sound, or the button on the right) lists the closest sounds in your library. Background listening now measures every sound for this.',
      'Hide a folder from All sounds: click the eye beside it under Libraries. Its sounds stay out of All sounds, search and the category counts, but are still listed when you open that folder.',
      'Undo: removing sounds from a project, deleting a project, clearing a rating, notes or Recently played, and hiding a folder all offer Undo (or Ctrl+Z).',
      'Spectrograms are sharp on short sounds and when zoomed in: one column per screen pixel, and smooth low frequencies.',
      'Notes, ratings and markers follow a file that’s moved to another folder.',
    ],
  },
  {
    version: '0.2.0-beta.5',
    date: '2026-10-13',
    items: [
      'Varispeed, tape-style: the speed slider next to the volume changes speed and pitch together, ±12 semitones ([ / ] keys, double-click resets). Dragged files keep their original speed. Can be hidden in Settings → Playback.',
      'MATCH (key M) plays every sound at the same perceived loudness while you audition, so quiet and loud files compare fairly. Your files aren’t changed; the target is in Settings → Playback.',
      'The info panel shows each sound’s loudness (LUFS) and true peak. It’s measured while the waveform loads, and short sounds are measured in the background while nothing is playing.',
      'SPECTRO (key V) shows frequencies over time instead of the waveform, sharpening as you zoom in. The level range slider beside it starts at 130 dB and stays where you leave it; scale, detail and colours are in Settings → Waveform.',
      'The transport bar fits smaller windows: labels make way first, then the sliders get shorter.',
    ],
  },
  {
    version: '0.2.0-beta.4',
    date: '2026-10-13',
    items: [
      'Long MP3 and FLAC files are decoded a piece at a time instead of all at once. A 52-minute MP3 now takes about a third of the memory it used to (≈460 MB instead of ≈1.5 GB), with identical sound.',
      'Your library folders are watched: sounds you add, rename or delete show up within a few seconds, without restarting. (Settings → Libraries)',
      'Choose which output device Soundfield plays through, separately from the Windows default, for example your audio interface. (Settings → Playback)',
      'Selections you drag into your DAW can be cleaned up automatically after 7, 30 or 90 days; they go to the Recycle Bin, and only files Soundfield made are touched. Off by default. (Settings → Saving & files)',
    ],
  },
  {
    version: '0.2.0-beta.3',
    date: '2026-10-13',
    items: [
      'Settings: the gear at the top right (or Ctrl+,). One section at a time, a plain description under every setting, a search box, and “Reset to defaults” per section. Changes apply right away.',
      'New options there: play on single click; a −60 dB level scale; the peak warning level; a default save folder for Soundfield search that’s kept between launches; turning Credits.txt off; where dragged selections are saved; preview cache size with “Clear now”; turning background sorting off; interface size and list row height; which tab opens first.',
      'All the safety limits (sizes, file counts, drag limits, network-drive deletes) are adjustable under Settings → Safety.',
      'Freesound and Epidemic setup moved from the Online top bar to Settings → Accounts.',
      'Settings → About → Copy problem report copies the version and recent errors, ready to paste when something goes wrong.',
    ],
  },
  {
    version: '0.2.0-beta.2',
    date: '2026-10-13',
    items: [
      'Projects show how much disk space they’d take if materialized (in the project bar and the sidebar tooltip).',
      'Materialize and Zip say how big they are, check the free space on the drive you pick, and stop if it won’t fit. Very large ones ask twice, can be cancelled while they run, and a cancelled one is cleaned up.',
      'Materializing into one of your own libraries now warns you first, because every copy would show up as a duplicate.',
      'Recycling shows the total size. Files on a network or USB drive (no Recycle Bin there, so deletes are permanent) get their own warning, and very large batches ask twice.',
      '“Extract here” never overwrites files that are already there, and checks the free space first. A zip that unpacks to far more than its own size gets a warning.',
      'Dragging hundreds of files (or many GB) into a DAW is stopped with a hint to use Materialize instead. Dragging out a long selection no longer loads it all into memory.',
      'Online: results show their file size, and huge saves or previews (some Internet Archive recordings are several GB) ask before downloading.',
      'Linking a whole drive, the Windows folder or your user folder as a library asks first. The “same audio” duplicate search says how much it may read, and can be cancelled.',
    ],
  },
  {
    version: '0.2.0-beta.1',
    date: '2026-10-13',
    items: [
      'Version and About: click the Soundfield name at the top left to see which version you have, when it was built, and these notes.',
      'What’s new: after each update, this note shows what changed. You’ll see it once per update.',
      'Your preferences (volume, columns, filters, layout and so on) now live in a settings file in Soundfield’s data folder, so a browser-storage wipe can’t reset them and backups can include them.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-12',
    items: [
      'Online search shows each site’s results as soon as it answers; a site that stalls times out with a clear message.',
      'Big Wikimedia Commons WAV / FLAC files preview through a small MP3 copy. Save still downloads the original.',
      'dB scale (−40 … 0 dBFS) beside the waveform, with each channel’s peak and RMS.',
      'Right-click a category to add all of its sounds to a project.',
      'Multi-select with Ctrl / Shift, recycle selected sounds, and Epidemic Sound in Soundfield search.',
      'Projects, Zip / Materialize, online sound search and the standalone app.',
    ],
  },
];

// Releases newer than `seen` (newest first). Nothing seen yet: just the newest one.
export function unseenReleases(seen) {
  if (!seen) return RELEASES.slice(0, 1);
  const i = RELEASES.findIndex(r => r.version === seen);
  return i < 0 ? RELEASES.slice(0, 1) : RELEASES.slice(0, i);
}
