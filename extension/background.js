import './validation.js';
import './frames.js';

const MENU_ID = 'sonora-read-selection';
const validation = globalThis.SonoraValidation;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
let menuTask = Promise.resolve();
const renderControllers = new Map();
const readerPorts = new Map(), tabReaders = new Map(), tabTasks = new Map();
let readerWrites = Promise.resolve();
const readersLoaded = chrome.storage.session?.get('sonoraReaders').then(saved => {
  for (const [tabId, reader] of Object.entries(saved.sonoraReaders || {})) tabReaders.set(Number(tabId), reader);
}).catch(() => {}) || Promise.resolve();
let playbackOwner = null;
let positionWrites = Promise.resolve();
function validPosition(record) {
  return record && typeof record.document === 'string' && record.document.length <= 4096
    && typeof record.prefix === 'string' && record.prefix.length <= 160 && typeof record.text === 'string' && record.text.length > 0 && record.text.length <= 1200
    && Number.isInteger(record.offset) && record.offset >= 0 && Number.isInteger(record.blockIndex) && record.blockIndex >= 0;
}
const ownerLoaded = chrome.storage.session?.get('sonoraPlaybackOwner').then(saved => { if (!playbackOwner) playbackOwner = saved.sonoraPlaybackOwner || null; }).catch(() => {}) || Promise.resolve();
const documentKey = sender => `${sender.tab?.id ?? 'reader'}:${sender.documentId || sender.frameId || 0}:`;
function cancelDocument(prefix) {
  for (const [key, controller] of renderControllers) if (key.startsWith(prefix)) controller.abort(new Error('Sonora document closed; render cancelled.'));
  if (playbackOwner && documentKey(playbackOwner).startsWith(prefix)) {
    playbackOwner = null;
    chrome.storage.session?.remove('sonoraPlaybackOwner').catch(() => {});
  }
}
chrome.runtime.onConnect?.addListener(port => {
  if (port.name !== 'sonora-reader') return;
  const key = documentKey(port.sender);
  readerPorts.set(key, {port, sender: port.sender});
  port.onDisconnect.addListener(() => {
    if (readerPorts.get(key)?.port === port) readerPorts.delete(key);
    cancelDocument(key);
  });
});
chrome.tabs?.onRemoved?.addListener(tabId => {
  cancelDocument(`${tabId}:`);
  readersLoaded.then(() => { tabReaders.delete(tabId); saveReaders(); });
});
// Only a committed top-level document replaces the reader. tabs.onUpdated also reports
// "loading" for history.pushState/replaceState, which single-page apps such as ChatGPT
// call during ordinary reading and which must not abort an in-flight render.
chrome.webNavigation?.onCommitted?.addListener(details => { if (details.frameId === 0) cancelDocument(`${details.tabId}:`); });
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

async function injectReader(tabId, frameId = 0, notice = '', choice = null, toggle = true) {
  const target = { tabId, frameIds: [frameId] };
  let lastError;
  let cssInjected = false;
  let readerInjected = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!readerInjected) {
        const version = chrome.runtime.getManifest().version;
        const results = await chrome.scripting.executeScript({ target, func: (version, notice, choice, toggle) => {
          window.__sonoraFrameNotice = notice;
          window.__sonoraFrameChoice = choice;
          if (window.__sonoraOverlay?.version !== version) return false;
          window.__sonoraOverlay.setFrameNotice?.(notice);
          window.__sonoraOverlay.setFrameChoice?.(choice);
          if (!notice && toggle) window.__sonoraOverlay.toggle();
          else window.__sonoraOverlay.show?.();
          return true;
        }, args: [version, notice, choice, toggle] });
        if (results?.[0]?.result) return;
        await chrome.scripting.executeScript({ target, files: ['text.js', 'speed.js', 'tempo.js', 'docs.js', 'passages.js', 'speech.js', 'words.js', 'overlay.js'] });
        readerInjected = true;
      }
      if (!cssInjected) {
        // Paint the controls before page CSS can invalidate a huge document.
        await chrome.scripting.executeScript({ target, func: () => new Promise(resolve => {
          const timer = setTimeout(resolve, 100);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
        }) });
        await chrome.scripting.removeCSS({ target, files: ['page.css'] });
        await chrome.scripting.insertCSS({ target, files: ['page.css'] });
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

function saveReaders() {
  readerWrites = readerWrites.catch(() => {}).then(() => chrome.storage.session?.set({sonoraReaders: Object.fromEntries(tabReaders)})).catch(() => {});
}
function inTab(tabId, task) {
  const next = (tabTasks.get(tabId) || Promise.resolve()).catch(() => {}).then(task);
  tabTasks.set(tabId, next);
  const finished = () => { if (tabTasks.get(tabId) === next) tabTasks.delete(tabId); };
  next.then(finished, finished);
  return next;
}
function sameReader(a, b) {
  return a?.tab?.id === b?.tab?.id && (a.documentId && b.documentId ? a.documentId === b.documentId : a.frameId === b.frameId);
}
async function disposeReader(reader) {
  const target = reader.documentId ? {documentId: reader.documentId} : {frameId: reader.frameId || 0};
  try {
    const response = await chrome.tabs.sendMessage(reader.tab.id, {type: 'sonora-dispose-reader'}, target);
    if (!response?.ok) throw new Error('Older reader');
  } catch {
    // Also retire a reader injected by an earlier extension version.
    try {
      await chrome.scripting.executeScript({target: {tabId: reader.tab.id,
        ...(reader.documentId ? {documentIds: [reader.documentId]} : {frameIds: [reader.frameId || 0]})},
        func: () => { window.__sonoraOverlay?.dispose?.(); }});
    } catch { /* A departed or restricted document has no reachable reader. */ }
  }
  cancelDocument(documentKey(reader));
}
async function activateReader(tab, frame, notice = '', choice = null, toggle = true) {
  await Promise.all([readersLoaded, ownerLoaded]);
  const next = {tab: {id: tab.id}, frameId: frame.frameId || 0, documentId: frame.documentId};
  const previous = new Map();
  for (const reader of [tabReaders.get(tab.id), ...[...readerPorts.values()].map(item => item.sender), playbackOwner]) {
    if (reader?.tab?.id === tab.id && !sameReader(reader, next)) previous.set(documentKey(reader), reader);
  }
  // Disposal, including audio and pending synthesis, finishes before injection.
  for (const reader of previous.values()) await disposeReader(reader);
  tabReaders.set(tab.id, next); saveReaders();
  await injectReader(tab.id, next.frameId, notice, choice, toggle);
}
async function openDocument(tab, selection = 'default') {
  const frames = globalThis.SonoraFrames;
  const topResult = (await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, func: frames.probeFrame}))?.[0];
  const top = topResult?.result;
  const large = frames.candidates(top, []).filter(frame => frames.largeFrame(frame, top));
  const choice = large.length ? {embedded: true} : null;
  const toggle = selection === 'default';
  if (top?.pdf) {
    await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, func: url => { window.__sonoraPdfUrl = url; }, args: [top.url || tab.url]});
    return activateReader(tab, topResult, '', null, toggle);
  }
  // A short or exhausted sample is not evidence of an empty document. Show
  // controls immediately; inspect children only after an explicit switch.
  if (selection !== 'embedded' && (selection === 'top' || frames.hasText(top) || top?.sample === 'inconclusive' || !large.length)) {
    return activateReader(tab, topResult || {frameId: 0}, '', choice, toggle);
  }
  const [probed, navigation] = await Promise.allSettled([
    chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, func: frames.probeFrame}),
    chrome.webNavigation?.getAllFrames({tabId: tab.id}) || Promise.resolve([])
  ]);
  const results = probed.status === 'fulfilled' ? probed.value : [topResult];
  const loaded = navigation.status === 'fulfilled' ? navigation.value || [] : [];
  const candidates = frames.candidates(top, results, loaded).filter(frame => frames.largeFrame(frame, top));
  const readable = candidates.find(frame => frames.hasText(frame.data));
  if (readable) return activateReader(tab, readable, '', {back: true}, toggle);
  for (const candidate of candidates) {
    if (candidate.data) continue;
    // Only loaded document URLs from a probe or browser navigation metadata
    // can authorize a host request. iframe.src is deliberately never used.
    const origin = frames.originPattern(candidate.url);
    if (!origin || await chrome.permissions.contains({origins: [origin]})) continue;
    const url = new URL(chrome.runtime.getURL('frame-permission.html'));
    url.search = new URLSearchParams({tab: tab.id, url: tab.url || top.url, origin}).toString();
    const site = origin === 'https://*.frame.claudeusercontent.com/*' ? 'all Claude artifacts' : new URL(origin).hostname;
    await activateReader(tab, topResult, `Embedded text needs access to ${site}. Allow access in the Sonora tab to read it.`, choice, false);
    const existing = (await chrome.tabs.query?.({url: chrome.runtime.getURL('frame-permission.html') + '*'}))?.find(item => item.url === url.href);
    if (existing) await chrome.tabs.update(existing.id, {active: true});
    else await chrome.tabs.create({url: url.href});
    return;
  }
  await activateReader(tab, topResult, 'Sonora could not access readable text in the embedded document. Its sandbox or site restrictions may block access; try opening the document in its own tab.', choice, false);
}
function injectSafely(tab, selection = 'default') {
  if (!tab || typeof tab.id !== 'number') return Promise.resolve();
  prewarmVoice();
  return inTab(tab.id, () => openDocument(tab, selection)).catch(error => {
    console.warn('Sonora could not open on this page:', error.message);
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && info.selectionText?.trim()) injectSafely(tab);
});
chrome.action.onClicked.addListener(tab => injectSafely(tab));

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
  if (message?.type === 'sonora-switch-document' && sender.tab) {
    const selection = message.document === 'top' ? 'top' : 'embedded';
    chrome.tabs.get(sender.tab.id).then(tab => injectSafely(tab, selection))
      .then(() => sendResponse({ok: true})).catch(error => sendResponse({ok: false, error: error.message}));
    return true;
  }
  if (message?.type === 'sonora-save-position') {
    if (message.record ? !validPosition(message.record) : typeof message.document !== 'string' || message.document.length > 4096) {
      sendResponse({ ok: false, error: 'Invalid reading position.' }); return false;
    }
    positionWrites = positionWrites.catch(() => {}).then(async () => {
      const saved = await chrome.storage.local.get('sonoraPositions');
      const document = message.record?.document || message.document;
      const previous = (Array.isArray(saved.sonoraPositions) ? saved.sonoraPositions : []).filter(record => validPosition(record) && record.document !== document);
      await chrome.storage.local.set({ sonoraPositions: (message.record ? [message.record, ...previous] : previous).slice(0, 20) });
      sendResponse({ ok: true });
    }).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'sonora-open-pdf-reader') {
    serverUrl().then(base => chrome.tabs.create({ url: base + '/' })).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'sonora-claim-playback') {
    ownerLoaded.then(async () => {
      await readersLoaded;
      const selected = tabReaders.get(sender.tab?.id);
      if (selected && !sameReader(selected, sender)) {
        await disposeReader(sender);
        sendResponse({ok: true, data: {owned: false}});
        return;
      }
      const previous = playbackOwner;
      const owner = { tab: sender.tab ? { id: sender.tab.id } : undefined, documentId: sender.documentId, frameId: sender.frameId };
      playbackOwner = owner;
      chrome.storage.session?.set({ sonoraPlaybackOwner: owner }).catch(() => {});
      if (previous?.tab?.id !== undefined && documentKey(previous) !== documentKey(owner)) {
        const target = previous.documentId ? { documentId: previous.documentId } : { frameId: previous.frameId || 0 };
        if (previous.tab.id === owner.tab?.id) await disposeReader(previous);
        else try { await chrome.tabs.sendMessage(previous.tab.id, { type: 'sonora-pause-playback' }, target); } catch { /* A closed document has no playback left to pause. */ }
      }
      sendResponse({ ok: true, data: { owned: playbackOwner === owner } });
    }).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'sonora-document-left') {
    cancelDocument(documentKey(sender)); sendResponse({ ok: true }); return false;
  }
  if (message?.type === 'sonora-frame-access') {
    (async () => {
      const url = new URL(sender.url);
      if (url.href.split('?')[0] !== chrome.runtime.getURL('frame-permission.html')) throw new Error('Invalid frame permission page.');
      const tab = await chrome.tabs.get(Number(url.searchParams.get('tab')));
      if (tab.url !== url.searchParams.get('url')) throw new Error('The page changed. Click Sonora again on the page you want to read.');
      const origin = globalThis.SonoraFrames.originPattern(url.searchParams.get('origin'));
      if (!origin) throw new Error('Invalid embedded site.');
      if (message.granted && await chrome.permissions.contains({ origins: [origin] })) await injectSafely(tab, 'embedded');
      else await inTab(tab.id, () => activateReader(tab, {frameId: 0}, `Frame permission was denied for ${origin === 'https://*.frame.claudeusercontent.com/*' ? 'all Claude artifacts' : new URL(origin).hostname}. Embedded text cannot be read until you allow access. Click Sonora to try again.`, {embedded: true}, false));
      await chrome.tabs.update?.(tab.id, { active: true });
      sendResponse({ ok: true });
    })().catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
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
