# @mintplex-labs/piper-tts-web 1.0.5 (MIT), vendored

Runs Piper text-to-speech voices in the browser. Used by the "Bluetooth speaker" announcer mode,
because iPhone sends website speech (speechSynthesis) to its own speaker, never to Bluetooth.

Copied from the npm package's `dist/` with three changes in `piper-tts-web.js` (search for "pikolq:"):
1. `onnxruntime-web/wasm` is imported from jsDelivr (onnxruntime-web@1.18.0), since this site has no bundler.
2. `numThreads = 1` (no cross-origin isolation on GitHub Pages).
3. Downloaded files are kept in the Cache API ("pikolq-voice-v1") instead of OPFS, which older Safari can't write to.

`voices_static-*.js` (the full voice list, 147 KB) was left out: it is only loaded by `voices()`, which this site never calls.
The engine runs in `js/tts-worker.js`; `js/app.js` downloads the voice files and plays the clips.

Voices: https://huggingface.co/diffusionstudio/piper-voices (Piper voices, MIT; each voice has its own MODEL_CARD).
