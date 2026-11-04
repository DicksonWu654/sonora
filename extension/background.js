import './validation.js';

const MENU_ID = 'sonora-read-selection';
const validation = globalThis.SonoraValidation;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
let menuTask = Promise.resolve();
const renderControllers = new Map();
const FETCH_TIMEOUT_MS = 30000;
const RENDER_TIMEOUT_MS = 120000;

function createMenu() {
  menuTask = menuTask.then(() => new Promise(resolve => {
    try {
      chrome.contextMenus.removeAll(() => {
        const removeError = chrome.runtime.lastError;
        if (removeError) {
          console.warn('Sonora could not reset its context menu:', removeError.message);
          resolve();
          return;
        }
        try {
          chrome.contextMenus.create({
            id: MENU_ID,
            title: 'Read selection with Sonora',
            contexts: ['selection']
          }, () => {
            const createError = chrome.runtime.lastError;
            if (createError) console.warn('Sonora could not create its context menu:', createError.message);
            resolve();
          });
        } catch (error) {
          console.warn('Sonora could not create its context menu:', error.message);
          resolve();
        }
      });
    } catch (error) {
      console.warn('Sonora could not reset its context menu:', error.message);
      resolve();
    }
  })).catch(() => {});
  return menuTask;
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);
// Also repair the menu when a developer reloads an unpacked extension.
createMenu();

async function injectReader(tabId) {
  let lastError;
  let cssInjected = false;
  let readerInjected = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!readerInjected) {
        const version = chrome.runtime.getManifest().version;
        const results = await chrome.scripting.executeScript({ target: { tabId }, func: version => {
          if (window.__sonoraOverlay?.version !== version) return false;
          window.__sonoraOverlay.toggle();
          return true;
        }, args: [version] });
        if (results?.[0]?.result) return;
        await chrome.scripting.executeScript({ target: { tabId }, files: ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js'] });
        readerInjected = true;
      }
      if (!cssInjected) {
        // Paint the controls before page CSS can invalidate a huge document.
        await chrome.scripting.executeScript({ target: { tabId }, func: () => new Promise(resolve => {
          const timer = setTimeout(resolve, 100);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
        }) });
        await chrome.scripting.removeCSS({ target: { tabId }, files: ['page.css'] });
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['page.css'] });
        cssInjected = true;
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
  throw lastError;
}

async function injectSafely(tab) {
  if (!tab || typeof tab.id !== 'number') return;
  // Do not wait for injection or page indexing to begin loading the voice.
  prewarmVoice();
  try {
    await injectReader(tab.id);
  } catch (error) {
    console.warn('Sonora could not open on this page:', error.message);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText?.trim()) return;
  injectSafely(tab);
});

chrome.action.onClicked.addListener(injectSafely);

async function serverUrl() {
  try {
    const saved = await chrome.storage.local.get('sonoraServer');
    return validation.normalizeServerUrl(saved.sonoraServer);
  } catch {
    return validation.DEFAULT_SERVER;
  }
}

async function prewarmVoice() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const base = await serverUrl();
    controller.signal.throwIfAborted();
    const response = await fetch(`${base}/api/narration/status`, { signal: controller.signal });
    await response.json();
  } catch { /* The overlay reports connection errors and retries without delaying injection. */ }
  finally { clearTimeout(timer); }
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const size = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += size) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  }
  return btoa(binary);
}

async function pageAudioSource(base, data, signal) {
  const audioUrl = validation.audioUrlFor(base, data?.audioUrl);
  const audioResponse = await fetch(audioUrl, { cache: 'no-store', signal });
  if (!audioResponse.ok) throw new Error(`Sonora audio returned ${audioResponse.status}.`);
  const contentType = (audioResponse.headers.get('content-type') || 'audio/wav').split(';', 1)[0];
  if (!/^audio\/[a-z0-9.+-]+$/i.test(contentType)) throw new Error('Sonora returned a non-audio response.');
  const length = Number(audioResponse.headers.get('content-length'));
  if (Number.isSafeInteger(length) && length > MAX_AUDIO_BYTES) throw new Error('Sonora returned an audio passage that is too large.');
  const buffer = await audioResponse.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_AUDIO_BYTES) throw new Error('Sonora returned an empty or oversized audio passage.');
  data.src = `data:${contentType};base64,${base64FromBuffer(buffer)}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
  const requestKey = `${sender.tab?.id ?? 'reader'}:${sender.documentId || sender.frameId || 0}:${message?.requestId || ''}`;
  if (message?.type === 'sonora-cancel-render' && message.requestId) {
    renderControllers.get(requestKey)?.abort(new Error('Sonora render cancelled.'));
    sendResponse({ ok: true });
    return false;
  }
  if (!message || !['sonora-status', 'sonora-render'].includes(message.type)) return false;
  if (message.type === 'sonora-render' && !validation.validRenderText(message.text)) {
    sendResponse({ ok: false, error: 'Sonora needs a readable passage under 4,000 characters.' });
    return false;
  }
  // Register before reading storage so a following cancellation cannot overtake it.
  const controller = new AbortController();
  if (message.type === 'sonora-render') renderControllers.set(requestKey, controller);
  const timer = setTimeout(() => controller.abort(new Error('Sonora request timed out. Try again.')), message.type === 'sonora-render' ? RENDER_TIMEOUT_MS : FETCH_TIMEOUT_MS);
  (async () => {
    const base = await serverUrl();
    controller.signal.throwIfAborted();
    const options = message.type === 'sonora-render' ? {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message.text, voice: message.voice }),
      signal: controller.signal
    } : { signal: controller.signal };
    const response = await fetch(`${base}/api/narration/${message.type === 'sonora-render' ? 'render' : 'status'}`, options);
    let data; try { data = await response.json(); } catch (error) { controller.signal.throwIfAborted(); data = {}; }
    if (!response.ok) throw new Error(data.error || `Sonora returned ${response.status}.`);
    if (message.type === 'sonora-render') {
      // Metadata means inference is finished; let the next inference overlap
      // this passage's WAV transfer, base64 conversion and browser decoding.
      if (sender.tab?.id !== undefined) {
        const target = sender.documentId ? { documentId: sender.documentId } : { frameId: sender.frameId || 0 };
        chrome.tabs?.sendMessage(sender.tab.id, { type: 'sonora-render-ready', requestId: message.requestId }, target)?.catch?.(() => {});
      }
      await pageAudioSource(base, data, controller.signal);
    }
    controller.signal.throwIfAborted();
    sendResponse({ ok: true, data });
  })().catch(error => sendResponse({ ok: false, error: controller.signal.reason?.message || error?.message || 'Sonora could not complete the request.' }))
    .finally(() => {
      clearTimeout(timer);
      if (renderControllers.get(requestKey) === controller) renderControllers.delete(requestKey);
    });
  return true;
});
