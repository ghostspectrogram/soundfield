// Streams PCM audio off disk and builds waveform peaks. A newer job id in the
// shared cancel slot aborts the current job between chunks, so scrolling
// quickly through a list never queues up stale work.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { decodePcm, PeakBuilder } from '../shared/pcm.mjs';

const latest = new Int32Array(workerData.cancel);
const CHUNK = 4 << 20;

parentPort.on('message', job => {
  try {
    run(job);
  } catch (err) {
    parentPort.postMessage({ type: 'error', jobId: job.jobId, message: String(err && err.message || err) });
  }
});

function run(job) {
  const { jobId, path, fmt, bucket, loud } = job;
  if (Atomics.load(latest, 0) !== jobId) return parentPort.postMessage({ type: 'cancelled', jobId });
  const frames = fmt.frames;
  const pb = new PeakBuilder(fmt.ch, frames, bucket, loud); // loud = { sr, weights }: also measure loudness
  const framesPerChunk = Math.max(1, Math.floor(CHUNK / fmt.blockAlign));
  const buf = new Uint8Array(new ArrayBuffer(framesPerChunk * fmt.blockAlign));
  const fd = fs.openSync(path, 'r');
  const t0 = Date.now();
  let lastPost = t0;
  try {
    let f = 0;
    while (f < frames) {
      if (Atomics.load(latest, 0) !== jobId) return parentPort.postMessage({ type: 'cancelled', jobId });
      const n = Math.min(framesPerChunk, frames - f);
      const want = n * fmt.blockAlign;
      const got = fs.readSync(fd, buf, 0, want, fmt.dataOffset + f * fmt.blockAlign);
      const nf = Math.floor(got / fmt.blockAlign);
      if (nf <= 0) break;
      pb.push(decodePcm(buf.subarray(0, nf * fmt.blockAlign), fmt, nf), nf);
      f += nf;
      const now = Date.now();
      if (now - lastPost > 300 && f < frames) {
        lastPost = now;
        parentPort.postMessage({ type: 'progress', jobId, peaks: pb.snapshot() });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  parentPort.postMessage({ type: 'done', jobId, peaks: pb.result() });
}
