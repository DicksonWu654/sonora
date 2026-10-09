# Privacy

Sonora's extension sends the selected reading passages to your own Sonora server at `http://127.0.0.1:8787`. The model generates speech locally. The extension rejects remote narration server addresses; no text is sent to a hosted speech API. There are no analytics or account requirements.

## What is stored

- Voice and speed preferences are stored in the browser's extension storage.
- Narration WAVs and timing metadata are cached under `~/.cache/sonora/narration-audio` by default, including audio generated from private pages. Model files and the isolated Python environment live under `~/.cache/sonora` too. On Windows, this means `.cache/sonora` inside your user profile.
- If you use book conversion, book text, checkpoints, MP3s, and locally generated access credentials are stored in `.runtime` inside the Sonora folder.

These are local files, not encrypted storage. People and applications with access to your user account or disk backups may be able to read them. To remove them, stop Sonora and delete the relevant cache or runtime folder. Removing the whole model cache requires downloading the voice again; removing `.runtime` deletes your book library and its podcast credentials.

## When Sonora uses the internet

First-time setup downloads Python, pinned packages, and the model from their upstream providers. The model is pinned to a specific Hugging Face revision and its main weights are checked against a known SHA-256 digest. Normal extension narration uses local files with Hugging Face and Transformers offline mode enabled.

The optional book-reader UI loads PDF.js or JSZip from public CDNs when importing PDF/EPUB files in the browser. Those requests fetch parser code; book bytes are parsed in your browser and sent to your local server for conversion. The command-line book importer uses installed local parsers.

The optional podcast tunnel is started only by `npm run tunnel`. It gives access to your studio/feed through secret links and Cloudflare's network. Publishing the source to GitHub does not start a tunnel or publish a library. Anyone given a secret feed link can download its available audio; keep those links private.

## Extension permissions

Sonora requests `activeTab` and `scripting` to add the reader when you click it, `storage` to remember preferences, and `contextMenus` for the optional right-click shortcut. Loopback host access lets the extension contact the local voice server. Google Docs host access enables a document-start flag that makes its canvas text available as positioned annotations. The flag does not start narration or send document text anywhere.

Other websites are read only when you activate Sonora there. The extension does not request browsing history, passwords, cookies, or access to every website in the background.

## Public distribution

The public source and release ZIP contain application code, installation instructions, tests, and a public-domain Moby-Dick sample. They exclude runtime data, credentials, generated speech, browser test artifacts, and model files. Release packaging uses committed source instead of copying the working directory, and refuses known private file paths.

Report a suspected privacy or security problem through [GitHub's private vulnerability reporting](https://github.com/DicksonWu654/sonora/security/advisories/new). Avoid putting page text, book text, or private links in a public issue.
