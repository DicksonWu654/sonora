# Contributing to Sonora

Contributions are welcome: bug fixes, documentation, accessibility improvements, and testing on Brave, Chrome, Windows, and Apple Silicon Macs. Linux x86-64 is currently the tested platform; see [INSTALL.md](INSTALL.md) for supported systems.

## Start with the right place

- Use [Discussions](https://github.com/DicksonWu654/sonora/discussions) for setup help, questions, and early ideas.
- Search [issues](https://github.com/DicksonWu654/sonora/issues) before reporting a bug or proposing a feature. The issue forms explain what information helps.
- For a larger change, open an issue first so we can agree on its scope. Small fixes and documentation improvements can go straight to a pull request.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

Use synthetic text or the public-domain sample for reproductions. Remove private document links, page text, books, generated speech, credentials, and identifying details from screenshots and logs. Read [PRIVACY.md](PRIVACY.md) for where Sonora stores local data.

## Set up a development checkout

Install Node.js 22 or newer and [uv](https://docs.astral.sh/uv/getting-started/installation/). Fork the repository on GitHub, then clone your fork:

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/sonora.git
cd sonora
git switch -c your-change
npm test
```

There are no npm dependencies to install. The JavaScript tests work without downloading the voice model. The ebook extraction test skips when its Python environment is unavailable; GitHub CI runs it with the parser dependencies installed.

To run extraction tests locally without installing the voice, create a small environment. On Linux or macOS:

```sh
uv venv --python 3.12 .venv/contribute
uv pip install --python .venv/contribute/bin/python beautifulsoup4==4.13.4 pypdf==5.4.0
NARRATION_PYTHON="$PWD/.venv/contribute/bin/python" npm test
```

On Windows, use PowerShell:

```powershell
uv venv --python 3.12 .venv/contribute
uv pip install --python .venv/contribute/Scripts/python.exe beautifulsoup4==4.13.4 pypdf==5.4.0
$env:NARRATION_PYTHON = (Resolve-Path .venv/contribute/Scripts/python.exe).Path
npm test
Remove-Item Env:NARRATION_PYTHON
```

For real narration and browser testing, run `npm run launch`. This installs the local voice on first launch and starts the server. Load this checkout's `extension/` folder through **Load unpacked** in `brave://extensions` or `chrome://extensions`. See [INSTALL.md](INSTALL.md) for the full setup.

## Where to make changes

| Location | Responsibility |
| --- | --- |
| `extension/` | In-page reader, passage extraction, Google Docs annotations, playback, and word highlighting. |
| `public/` | Local book-reader interface and shared text chunking. |
| `tools/narration/` | Kokoro setup, model worker, timing metadata, and audio caching. |
| `tools/books/` | Book extraction, durable conversion jobs, RSS, and optional tunnel. |
| `server.js` | Loopback HTTP server and route wiring. |
| `tests/` | Node.js tests, synthetic fixtures, and Python extraction checks. |
| `tools/launch.js`, `tools/release.js` | First-run setup and source-only release packaging. |

Keep text chunking in `public/text.js` and its identical extension copy. If changing extension injection, keep the injected file list and Manifest V3 permissions consistent. The server should continue to bind to loopback, and extension narration requests should stay local.

## Verify your change

Run `npm test` and `git diff --check`. Add a regression test when it can reliably exercise the behavior being fixed. Documentation changes only need relevant documentation checks and the existing checks.

For narration or audio assembly changes, also generate a short real Kokoro sample and check that it plays. For browser changes, test the affected flow with the actual unpacked extension. Check pause/resume, speed changes, jumping to another passage, and closing the reader when relevant. Refresh an already open Google Doc after reloading the extension; test document paragraphs and table cells when changing Docs support.

Describe your results and any untested platforms in the pull request. GitHub CI checks tests, fresh voice-dependency resolution, and release packaging. It does not generate speech or exercise a real browser.

## Submit a pull request

Keep the change focused and explain the user-visible problem, the resulting behavior, and how you checked it. Link the relevant issue if there is one. Follow existing code style; avoid unrelated formatting changes.

Before committing, inspect `git status` and the staged diff. Runtime data belongs in `.runtime/`, model assets and audio caches belong outside Git, and browser artifacts belong in ignored `output/` or `.playwright-cli/` directories. Never add credentials, private books, generated audio, or machine-specific paths. GitHub push protection and release packaging provide additional checks.

By submitting a contribution, you agree that your original work can be distributed under the project's [MIT license](LICENSE). Preserve applicable notices for any third-party code or assets. Everyone participating should follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Maintainer releases

Release packaging requires a clean, committed checkout. Run `npm run release:zip` to build `dist/Sonora.zip` from Git-tracked source. Review the archive, scan the public history and ZIP for secrets, and publish a checksum with the ZIP. Keep `package.json`, `extension/manifest.json`, and the overlay version consistent for a new application version. Wait for GitHub checks before publishing a release.
