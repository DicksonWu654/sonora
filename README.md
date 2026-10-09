# Sonora

[![Checks](https://github.com/DicksonWu654/sonora/actions/workflows/checks.yml/badge.svg)](https://github.com/DicksonWu654/sonora/actions/workflows/checks.yml) · [MIT license](LICENSE) · [Latest release](https://github.com/DicksonWu654/sonora/releases/latest)

Click text on a web page and hear it read aloud with a natural, local voice. Sonora works in **Brave and Chrome**, including Google Docs paragraphs and tables, and highlights each spoken word directly on the page. Pause, switch voices, jump to another passage, or listen at **0.75×–3× without changing the voice's pitch**.

Speech runs on your computer with Kokoro 82M. There is no subscription, API key, or cloud speech service. You can also turn PDF, EPUB, TXT, and Markdown books into downloadable MP3s and a private podcast feed.

## Install in four steps

1. Install [Node.js 22 or newer](https://nodejs.org/en/download) and [uv](https://docs.astral.sh/uv/getting-started/installation/). These are one-time prerequisites; Sonora installs Python and the voice model for you.
2. [Download the latest Sonora ZIP](https://github.com/DicksonWu654/sonora/releases/latest/download/Sonora.zip), then extract it to a folder you will keep.
3. Start **Start Sonora.bat** on Windows, **Start Sonora.command** on an Apple Silicon Mac, or run **Start Sonora.sh** on Linux. The first launch downloads the voice and may take several minutes. Keep the terminal window open while reading.
4. Open `brave://extensions` or `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the extracted **extension** folder. Pin Sonora from the browser's Extensions menu.

Open a page, click Sonora's toolbar icon, and click the text you want to hear. For an already open Google Doc, refresh it once after installing the extension.

**[Detailed installation and troubleshooting →](INSTALL.md)** · **[Privacy →](PRIVACY.md)** · **[Questions and help →](https://github.com/DicksonWu654/sonora/discussions)**

Linux x86-64 is tested. Launchers and dependency configuration are provided for Windows x86-64 and Apple Silicon Macs; those platforms have not yet been tested on real hardware. Intel Macs and Windows/Linux ARM are not supported by this installer. A GPU is optional.

For developers, clone and launch with:

```sh
git clone https://github.com/DicksonWu654/sonora.git
cd sonora
npm run launch
```

There are no npm dependencies to install. Node.js and uv must already be available. Later launches reuse the installed voice.

## Convert books and listen as a podcast

1. Install the local voice once if you have not used the launcher:

   ```sh
   npm run voice:setup
   ```

2. Run `npm start` in one terminal. In another terminal, check a short sample, then convert your book:

   ```sh
   npm run convert -- public/moby-dick.txt --title 'Moby-Dick preview' --preview
   npm run convert -- '/path/to/book.epub' --title 'Book title'
   ```

   Each command waits until its MP3 is ready. For an EPUB containing multiple volumes, extract only the intended volume first.

3. Run `npm run tunnel`, open the private studio link saved in `.runtime/access.json`, and copy the private RSS URL into your podcast app. Install `cloudflared` before this step. Completed books appear in the feed automatically.

4. Keep the server and tunnel running while your podcast app downloads the audio. Stop the tunnel with Ctrl+C when finished. Books stay on disk, but the public feed goes offline; a restarted Quick Tunnel has a new hostname, so update your podcast subscription with its new URL.

GitHub stores application source and runs automated checks on pushes and pull requests. Books, generated audio, model files, and private feed credentials remain on your machine. Back up `.runtime/` separately to preserve your library and credentials. GitHub Actions checks extraction, checkpoint recovery, text splitting, RSS, and audio ranges; actual voice generation runs locally.

## Start

```sh
npm run voice:setup
npm start
```

Open <http://127.0.0.1:8787>. Import a book, choose Heart or Bella, and select **Make short preview** or **Convert full book to MP3**. Conversion continues on the server after you close the browser. The library shows progress, retry controls, finished audio, downloads, and the private RSS URL.

## Read page text in Chrome or Brave

The repository includes a small Manifest V3 extension in `extension/`. Click its toolbar button on any readable page and it opens an in-page Sonora panel: article text blocks, table cells, and headings on the page become clickable, with Heart or Bella voice selection, a 0.75×–3× speed control, passage progress, and background rendering of the next passage. Wikipedia navigation, infoboxes, references, and other page chrome are left out of the reading queue. Text and audio stay on this machine.

1. Start Sonora with `npm start` and wait for the local voice chip to say **local voice ready**.
2. Open `brave://extensions` or `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the repository's `extension/` directory.
3. After pulling an update, click **Reload** on the Sonora card in the extensions page so Brave/Chrome runs the new unpacked files, then refresh any page that already had Sonora open. Open a page, click the Sonora toolbar button, and click any highlighted text block, table cell, or heading on the page. Playback starts at that block and continues through the remaining article; click another block at any time to jump there. The right-click action remains as a fallback; it now opens the same panel instead of a new tab. The extension uses the local server address saved by the reader, defaulting to `http://127.0.0.1:8787`.

Brave supports Chrome Manifest V3 extensions, so the same unpacked extension works in both browsers. Text is split into passages under the local model's request limit; the next passage is rendered while the current one plays. The extension does not call a cloud speech API.

The current local engine is Kokoro 82M, which is already a compact neural voice. The extension's speed control preserves voice pitch and changes playback without asking the model to synthesize a second copy at each speed. CPU and CUDA setup options remain the same as the book reader; use `npm run voice:setup:gpu` when CUDA is available for lower first-passage latency.

An amber highlight follows the current word using the voice model's word timings. It stays synchronized with playback speed, freezes when paused, and clears when you stop or close the reader. Regular page text uses the browser's text highlight API; Google Docs uses positioned marks over its painted words. Page text remains editable and links keep their original markup. Passages without usable timings or matching text retain the passage highlight.

Google Docs paragraphs and table entries use the document's positioned canvas annotations for clicking and highlighting. After installing or reloading Sonora, refresh an already open Google Doc once so Docs enables those annotations at startup. Sonora keeps the reading queue while Docs recycles its canvas tiles during scrolling, and adds newly discovered pages after the queued passages. Clicking again uses the latest discovered text. Switching document tabs selects the active tab's passages; sharing controls and the document toolbar are excluded.

If this Linux machine already has working CUDA PyTorch in its system Python, `npm run voice:setup:gpu` creates an isolated voice environment that reuses that installation. The server then selects the GPU automatically. To force CPU, set `NARRATION_DEVICE=cpu` and `NARRATION_PYTHON` to `~/.cache/sonora/narration-venv/bin/python` when starting the server. Setup downloads a pinned, checksum-verified Kokoro model; ordinary narration uses local assets without external speech APIs.

## Convert a file from the terminal

With the server running:

```sh
npm run convert -- /path/to/book.epub --title 'Book title' --voice af_heart
npm run convert -- /path/to/book.epub --preview
```

The CLI extracts EPUB content in spine order, and supports selectable-text PDFs, TXT, and Markdown. Scanned PDFs need OCR first. Encrypted ebooks must be supplied as unlocked, DRM-free copies. Existing jobs with the same text, title, and voice are reused. A failed job can be retried from the studio without losing its saved passages.

## Cloudflare Tunnel and podcast listening

Install Cloudflare's `cloudflared`, then run this in a second terminal:

```sh
npm run tunnel
```

The tunnel's **private studio link** and **private RSS link** are saved to `.runtime/access.json` with owner-only permissions. Open the studio link to log in, then choose **Copy private RSS URL**. In your podcast app, use its “add podcast by URL” option. Feed access does not require the studio's session cookie. Keep these links private.

This launcher uses a Cloudflare Quick Tunnel. Its hostname changes when the tunnel restarts and it depends on this machine staying online. For a permanent subscription, configure a named Cloudflare Tunnel with your own hostname pointing to `http://127.0.0.1:8787`, and set `PUBLIC_BASE_URL=https://your-hostname` when starting Sonora. Your saved books and feed token stay the same. Do not put interactive Cloudflare Access authentication in front of the feed/audio routes; podcast apps need to fetch them using their secret URLs.

## Long books and storage

Text is normalized to remove import artifacts, then split at paragraph, sentence, or word boundaries with a hard limit of 1,200 UTF-16 characters. Long words use safe Unicode boundaries. Model errors retry smaller passages; temporary worker failures retry without dropping text. Completed passages are cached and every book has a durable checkpoint. Interrupted jobs resume on server restart; corrupt cached audio is regenerated. Failed or partial MP3s are excluded from RSS.

FFmpeg joins cached passages on disk into 24 kHz mono, 96 kb/s MP3; the browser never holds a whole book's decoded audio. RSS enclosures include file sizes and durations, and audio routes support HEAD and byte ranges for downloads and seeking. Browser voices are a listening fallback; downloadable MP3s use Kokoro.

Private text, credentials, checkpoints, logs, and MP3s live in `.runtime/` (or `SONORA_DATA`). Model assets and per-passage WAV caches live in `~/.cache/sonora` (or `NARRATION_HOME`). These are excluded from Git. Long books can consume several GB of WAV cache and produce MP3s of hundreds of MB. Keep the WAV cache while an incomplete job may need to resume. Back up `.runtime/` for the feed credentials and finished books.

## Checks

`npm test` checks full-book chunk coverage, long paragraphs, Unicode, restart recovery, adaptive splitting, complete-only RSS, and podcast byte ranges. Validate narration changes with a short actual Kokoro conversion as well. The public-domain Moby-Dick fixture is `public/moby-dick.txt`.

## License

Sonora's code is available under the [MIT license](LICENSE). The voice model and third-party assets have their own [licenses and notices](THIRD_PARTY_NOTICES.md).

## Contributing and community

Sonora is open source, and contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the code map, testing, and submitting a pull request. Documentation, accessibility improvements, and testing on Windows and Apple Silicon Macs are useful ways to help.

Use [Discussions](https://github.com/DicksonWu654/sonora/discussions) for questions and ideas, and [issues](https://github.com/DicksonWu654/sonora/issues/new/choose) for reproducible bugs or feature requests. Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately through [SECURITY.md](SECURITY.md), and keep private documents and credentials out of public reports.
