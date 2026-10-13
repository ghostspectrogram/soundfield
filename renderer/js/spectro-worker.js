// Spectrogram FFTs off the main thread. The page sends a plan, then blocks of audio in order;
// partial results come back every quarter second so the picture fills in as it's computed.
import { SpectroBuilder } from '../../shared/spectro.mjs';

let job = null;

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'begin') {
    job = { id: m.id, sb: new SpectroBuilder({ ch: m.ch, N: m.N, plan: m.plan }), sent: performance.now() };
  } else if (m.type === 'data') {
    if (!job || job.id !== m.id) return; // a newer request replaced this one
    job.sb.push(m.data, m.n, m.at, m.last);
    if (m.last || performance.now() - job.sent > 250) {
      job.sent = performance.now();
      self.postMessage({ id: job.id, final: !!m.last, data: job.sb.data.map(d => d.slice()) });
    }
  }
};
