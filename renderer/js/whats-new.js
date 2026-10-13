// Release notes shown once after an update ("What's new") and in About. Newest first.
// Each version's entry lists what someone using Soundfield will notice, in plain words.
export const RELEASES = [
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
