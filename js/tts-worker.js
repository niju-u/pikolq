/**
 * Bluetooth voice: makes the announcer's audio clips in the background, so the page never freezes.
 * Started by app.js as a module worker. Messages in:  { id, type: 'init', voiceId, ortBase, piperBase }
 *                                                     { id, type: 'predict', text }
 * Messages out: { id, ok: true, buf? }  (buf = the WAV file's bytes)  or  { id, ok: false, error }.
 * The voice files were downloaded into the Cache API by app.js; they are read from there (works offline).
 */
import * as tts from './vendor/piper-tts-web/piper-tts-web.js';

const CACHE = 'pikolq-voice-v1';
let session = null;
let sessionVoice = null;

/** A blob URL for a cached file, or the original URL if it isn't cached. */
async function cachedUrl(url) {
  const cache = await caches.open(CACHE);
  const res = await cache.match(url);
  return res ? URL.createObjectURL(await res.blob()) : url;
}

async function init({ voiceId, ortBase, piperBase }) {
  if (session && sessionVoice === voiceId) return;
  const wasmPaths = {
    onnxWasm: { 'ort-wasm-simd.wasm': await cachedUrl(`${ortBase}ort-wasm-simd.wasm`), 'ort-wasm.wasm': `${ortBase}ort-wasm.wasm` },
    piperWasm: await cachedUrl(`${piperBase}.wasm`),
    piperData: await cachedUrl(`${piperBase}.data`),
  };
  tts.TtsSession._instance = null; // the engine keeps one session; start a fresh one for this voice
  const next = new tts.TtsSession({ voiceId, wasmPaths });
  await next.waitReady;
  session = next;
  sessionVoice = voiceId;
}

self.onmessage = async e => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      await init(msg);
      self.postMessage({ id: msg.id, ok: true });
    } else if (msg.type === 'predict') {
      if (!session) throw new Error('The voice is not loaded');
      const buf = await (await session.predict(msg.text)).arrayBuffer();
      self.postMessage({ id: msg.id, ok: true, buf }, [buf]);
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
