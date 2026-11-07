- `public/` is the existing reader; `tools/books/` owns durable conversion and RSS.
- Kokoro assets live outside Git in `~/.cache/sonora`; `.runtime/` contains private book text, credentials, job checkpoints, and MP3s. Never commit it or print its credentials in logs.
- The HTTP server binds to loopback. Tunnel access to the studio requires its private session link; podcast clients use a separate secret feed URL.
- Keep chunking shared between the browser and server in `public/text.js`. Conversions must checkpoint on disk and continue without an open browser.
- Check EPUB metadata and spine against the requested title; filenames can mislabel omnibus archives. Extract only the requested volume before narration.
- Run `npm test` and a short real Kokoro conversion for changes to narration or assembly. Do not narrate a whole book just to test.

- Scroll comparisons use `tools/profile-scroll.cjs` with at least five interleaved repetitions, a fixed fixture hash and wheel path, and recorded host load. Report median/IQR from the inner-scrollport fixture.

## Testing

- Iterate with targeted feature files (`node --test tests/<feature>.test.js`).
- Run `npm test` before committing: pure logic and five smoke cases share one browser; keep this tier under 10 seconds.
- Run `npm run test:full` once before pushing. It covers the remaining browser, backend, import, and conversion regressions.
- Do not repeat suite runs to prove stability unless investigating a flake. Keep one regression per user-visible bug class; share browsers within each feature file.
