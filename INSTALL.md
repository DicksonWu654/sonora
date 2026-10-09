# Install Sonora

Sonora has two parts: a browser extension and a local voice server. Install the extension once; keep the voice launcher running whenever you want to listen.

## 1. Install the prerequisites once

Use Node.js **22 or newer** and uv. Python, FFmpeg, and the Kokoro voice are installed automatically on the first launch. Allow several GB of free disk space for dependencies, the model, and cached audio. Internet is needed for setup; ordinary extension narration uses the installed model offline.

### Windows x86-64

In PowerShell, run these two commands, then close and reopen the terminal:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id astral-sh.uv --exact
```

If you do not use winget, install Node.js from [nodejs.org](https://nodejs.org/en/download) and follow the [official Windows uv instructions](https://docs.astral.sh/uv/getting-started/installation/).

### Apple Silicon Mac

If you already use Homebrew:

```sh
brew install node uv
```

Otherwise, use the [Node.js macOS installer](https://nodejs.org/en/download) and [official uv instructions](https://docs.astral.sh/uv/getting-started/installation/). Use native ARM64 Node.js rather than an Intel build running under Rosetta.

### Linux x86-64

Install Node.js 22+ from [nodejs.org](https://nodejs.org/en/download), or your distribution if it supplies a current version. Install uv using its [official instructions](https://docs.astral.sh/uv/getting-started/installation/).

Linux has been tested. Windows and Mac launchers are provided, but hardware testing on those systems is still needed. The installer currently excludes Intel Macs and Windows/Linux ARM.

## 2. Download and start Sonora

1. [Download Sonora.zip](https://github.com/DicksonWu654/sonora/releases/latest/download/Sonora.zip).
2. Extract the ZIP. Keep the extracted folder: the browser loads the extension from it.
3. Start the launcher for your system:

| System | Launcher |
| --- | --- |
| Windows | Double-click **Start Sonora.bat**. |
| Mac | Double-click **Start Sonora.command**. If macOS blocks it, use Terminal as described below. |
| Linux | Open a terminal in the extracted folder and run `sh "Start Sonora.sh"`. |

The first launch creates an isolated Python 3.12 environment, installs pinned dependencies, and downloads the pinned Kokoro model. No system Python packages are changed. Following launches reuse the installed voice. Leave this terminal open while reading; press **Ctrl+C** to stop.

You can always launch from a terminal in the extracted folder:

```sh
npm run launch
```

On macOS, if Finder refuses to open the downloaded command file, open Terminal in the extracted folder and run `sh "Start Sonora.command"`. This avoids changing global macOS security settings.

## 3. Add the extension once

1. Type **brave://extensions** or **chrome://extensions** into the address bar.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the **extension** subfolder inside the extracted Sonora folder. Select the folder containing `manifest.json`.
4. Open the browser's Extensions menu and pin **Sonora — read page aloud**.

No Chrome Web Store account or browser restart is needed. Sonora is currently distributed as an unpacked extension rather than through the Web Store.

## 4. Read a page

Open a normal web page, click Sonora's toolbar icon, and wait for **Ready — click page text to begin**. Click a paragraph, heading, or table cell directly on the page. It reads from there through the remaining discovered passages.

- Click another passage to jump there.
- Use the floating panel to pause/resume, change voice, or choose 0.75×–3× speed.
- Minimize the panel to keep it out of the way; click Sonora's toolbar icon to show it again.
- Close the panel to stop reading and remove the page highlights.

For Google Docs, **refresh the Doc once after installing or reloading Sonora**. This enables the positioned text annotations needed for paragraph highlighting. Sonora ignores document toolbars and sharing controls. Scrolling can reveal more passages, which are added to the reading queue. Switching document tabs resets the reading session.

Browser settings pages, the extension store, inaccessible content, and scanned images are not readable. Google Docs support depends on its canvas annotations and may need updating if Google changes its editor. Narration is currently English, with Heart and Bella voices.

## Updating

Download the new ZIP, stop the launcher, and copy its files over your existing Sonora folder. Keep any `.runtime` folder so your optional book library is preserved. Start Sonora again, click **Reload** on its card in the browser's extensions page, and refresh pages with Sonora open. If you use a different folder, remove the old extension and load the new folder instead.

## Troubleshooting

| Message or problem | What to do |
| --- | --- |
| Node.js is missing or too old | Install Node.js 22+ and reopen the launcher. On Windows, reopen terminals after installing. |
| Install uv | Follow the official uv instructions, reopen the terminal, and launch again. The installer also checks uv's standard `~/.local/bin` location. |
| Sonora is offline | Start the launcher and leave it open. The default server is `http://127.0.0.1:8787`. |
| Warming up the local voice | Wait for the model to load. The first load can take longer than later ones. |
| First-time download was interrupted | Run the launcher again. Downloads and already installed dependencies are reused. |
| Google Docs has no passage highlights | Reload the extension, then refresh the Doc. |
| Extension still behaves like an old version | Click **Reload** in the extensions page and refresh the website. |
| Server says the port is in use | Check whether Sonora is already running. Stop the old instance before starting a new one. |
| Browser cannot load the extension | Extract the ZIP first, then select its **extension** folder rather than the ZIP or the outer Sonora folder. |

The launcher prints the exact extension folder to select. To check your environment without installing or starting anything, run `node tools/launch.js --check`.
