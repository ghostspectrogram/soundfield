// Release notes shown once after an update ("What's new") and in About. Newest first.
// Each version's entry lists what someone using Soundfield will notice, in plain words.
export const RELEASES = [
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
