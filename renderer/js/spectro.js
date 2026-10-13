// Feeds audio to the spectrogram worker. Two kinds of picture per sound:
//   overview: the whole sound in ~2,000 columns (computed once when the view is on)
//   detail:   the visible range at screen resolution, when zooming in past the overview
import { planWindows, planReads } from '../../shared/spectro.mjs';

export class SpectroFeeder {
  constructor(onResult) {
    this.onResult = onResult; // ({ kind, start, end, cols, bins, N, sr, data, final }) => void
    this.worker = new Worker(new URL('./spectro-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = e => {
      const r = this.reqs.get(e.data.id);
      if (!r) return;
      if (e.data.final) this.reqs.delete(e.data.id);
      this.onResult({ ...r.meta, data: e.data.data, final: e.data.final });
    };
    this.reqs = new Map();
    this.seq = 0;
    this.current = 0; // only the newest request keeps reading audio
  }

  // source: { readFrames, frames, sr, ch }. Resolves when all audio has been sent (or superseded).
  async compute(source, kind, { start = 0, end = source.frames, cols, perCol, N }) {
    const id = ++this.seq;
    this.current = id;
    for (const k of this.reqs.keys()) if (k !== id) this.reqs.delete(k);
    const plan = planWindows({ start, end, cols, perCol, N, frames: source.frames });
    const meta = { kind, start, end, cols: plan.cols, bins: N / 2 + 1, N, sr: source.sr, source };
    this.reqs.set(id, { meta });
    this.worker.postMessage({ type: 'begin', id, ch: source.ch, N, plan });
    const reads = planReads(plan, N);
    for (let i = 0; i < reads.length; i++) {
      if (this.current !== id) return false;
      const [a, b] = reads[i];
      const data = await source.readFrames(a, b - a);
      if (this.current !== id) return false;
      this.worker.postMessage({ type: 'data', id, at: a, n: data[0] ? data[0].length : 0, data, last: i === reads.length - 1 }, data.map(d => d.buffer));
    }
    return true;
  }

  cancel() { this.current = ++this.seq; this.reqs.clear(); }
}
