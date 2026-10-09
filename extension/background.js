import './validation.js';

const MENU_ID = 'sonora-read-selection';
const validation = globalThis.SonoraValidation;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
let menuTask = Promise.resolve();

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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!cssInjected) {
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['page.css'] });
        cssInjected = true;
      }
      await chrome.scripting.executeScript({ target: { tabId }, files: ['text.js', 'tempo.js', 'docs.js', 'passages.js', 'words.js', 'overlay.js'] });
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

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const size = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += size) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  }
  return btoa(binary);
}

async function pageAudioSource(base, data) {
  const audioUrl = validation.audioUrlFor(base, data?.audioUrl);
  const audioResponse = await fetch(audioUrl, { cache: 'no-store' });
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
  if (!message || !['sonora-status', 'sonora-render'].includes(message.type)) return false;
  if (message.type === 'sonora-render' && !validation.validRenderText(message.text)) {
    sendResponse({ ok: false, error: 'Sonora needs a readable passage under 4,000 characters.' });
    return false;
  }
  (async () => {
    const base = await serverUrl();
    const options = message.type === 'sonora-render' ? {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message.text, voice: message.voice })
    } : undefined;
    const response = await fetch(`${base}/api/narration/${message.type === 'sonora-render' ? 'render' : 'status'}`, options);
    let data; try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw new Error(data.error || `Sonora returned ${response.status}.`);
    if (message.type === 'sonora-render') await pageAudioSource(base, data);
    sendResponse({ ok: true, data });
  })().catch(error => sendResponse({ ok: false, error: error?.message || 'Sonora could not complete the request.' }));
  return true;
});
