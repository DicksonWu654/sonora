(() => {
  const OVERLAY_VERSION = '0.4.2';
  if (window.__sonoraOverlay) {
    if (window.__sonoraOverlay.version === OVERLAY_VERSION) {
      window.__sonoraOverlay.toggle();
      return;
    }
    try { window.__sonoraOverlay.dispose?.(); } catch { /* Replace stale overlays even if their old context was invalidated. */ }
    document.querySelector('#sonora-overlay-root')?.remove();
    delete window.__sonoraOverlay;
  }

  const { cleanText, chunksFor } = window.BookText;
  const MAX_PAGE_CHARS = 240000;
  const PAGE_CLASS = 'sonora-readable-block';
  const CURRENT_CLASS = 'sonora-current-block';
  let docsSurface = null;
  let docsEntries = [];
  let docsDocumentChanged = false;
  let reconcileEntries = window.SonoraPassages.createReconciler();
  let pageEntries = [];
  const source = findReadableSource();
  let pageText = cleanText(source.text).slice(0, MAX_PAGE_CHARS);
  let blockEntries = makeBlockEntries(source.blocks);
  const root = document.createElement('div');
  root.id = 'sonora-overlay-root';
  const shadow = root.attachShadow({ mode: 'closed' });
  const panelMarkup = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel, button, select { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .panel { position: fixed; z-index: 2147483647; top: 16px; right: 16px; width: min(390px, calc(100vw - 32px)); max-height: calc(100vh - 32px); display: flex; flex-direction: column; overflow: hidden; color: #eff2ec; background: #121815f7; border: 1px solid #354239; border-radius: 12px; box-shadow: 0 18px 70px #000b, 0 2px 12px #0008; backdrop-filter: blur(18px); }
      .panel.is-hidden { display: none; }
      .word-mark { position: fixed; z-index: 2147483646; pointer-events: none; border-radius: 2px; background: rgba(239, 201, 135, .65); box-shadow: inset 0 -2px #b27635; }
      .top { display: flex; align-items: center; gap: 10px; padding: 15px 16px 13px; border-bottom: 1px solid #2d3930; }
      .mark { color: #d8b28b; font-size: 19px; transform: rotate(-45deg); }
      .brand { font-size: 14px; font-weight: 700; letter-spacing: -.035em; }
      .local { display: flex; align-items: center; gap: 6px; margin-left: auto; color: #849186; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
      .local i, .dot { width: 6px; height: 6px; display: inline-block; border-radius: 50%; background: #718076; }
      .local i { background: #7dbb8d; box-shadow: 0 0 0 3px #7dbb8d18; }
      .icon { width: 27px; height: 27px; display: grid; place-items: center; margin-left: 3px; border: 0; border-radius: 5px; background: transparent; color: #849186; font-size: 19px; line-height: 1; cursor: pointer; }
      .icon:hover, .icon:focus-visible { color: #eff2ec; background: #27332b; }
      .heading { padding: 17px 16px 13px; }
      .eyebrow { margin: 0 0 7px; color: #d8b28b; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .13em; }
      h2 { max-width: 330px; margin: 0; overflow: hidden; color: #eff2ec; font: 500 24px/1.05 Georgia, "Times New Roman", serif; letter-spacing: -.035em; text-overflow: ellipsis; white-space: nowrap; }
      .meta { margin: 8px 0 0; color: #849186; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .status { display: flex; align-items: center; gap: 8px; min-height: 24px; padding: 0 16px 12px; color: #b7c0b6; font-size: 11px; }
      .dot.ready { background: #7dbb8d; box-shadow: 0 0 0 3px #7dbb8d18; }
      .dot.busy { background: #d8b28b; animation: sonar-blink 1.2s ease-in-out infinite; }
      .dot.error { background: #dc8d71; }
      .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; padding: 0 16px 14px; }
      label { display: grid; gap: 5px; color: #849186; font: 8px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .09em; text-transform: uppercase; }
      select { width: 100%; min-height: 34px; padding: 0 8px; border: 1px solid #354239; border-radius: 5px; outline: 0; background: #202b23; color: #dce1d9; font-size: 11px; text-transform: none; letter-spacing: 0; }
      select:focus-visible, button:focus-visible { outline: 2px solid #d8b28b; outline-offset: 2px; }
      .selection { margin: 0 16px 14px; padding: 13px 14px; border: 1px solid #354239; border-radius: 7px; background: #18221b; }
      .selection-title { margin: 0 0 5px; color: #d8b28b; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }
      .selection-copy { margin: 0; color: #aeb8ac; font: 12px/1.45 Georgia, "Times New Roman", serif; }
      .bottom { padding: 12px 16px 15px; border-top: 1px solid #2d3930; background: #151d18f7; }
      .transport { display: flex; align-items: center; gap: 9px; }
      .transport button { min-height: 37px; border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: 650; }
      .play { flex: 1; border: 0; background: #d8b28b; color: #2b2119; }
      .play:hover { background: #e6c6a6; }
      .stop { width: 65px; border: 1px solid #354239; background: transparent; color: #aeb8ac; }
      .stop:hover { border-color: #d8b28b; color: #eff2ec; }
      .track { height: 3px; margin: 12px 0 0; overflow: hidden; border-radius: 2px; background: #354239; }
      .track i { display: block; width: 0; height: 100%; background: #d8b28b; transition: width .15s; }
      .hint { margin: 9px 0 0; color: #718076; font: 9px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
      @keyframes sonar-blink { 50% { opacity: .35; } }
      @media (prefers-reduced-motion: reduce) { .dot.busy { animation: none; } }
    </style>
    <aside class="panel" aria-label="Sonora page reader">
      <header class="top"><span class="mark" aria-hidden="true">◒</span><span class="brand">sonora</span><span class="local"><i></i> local voice</span><button class="icon minimize" type="button" aria-label="Minimize Sonora">−</button><button class="icon close" type="button" aria-label="Close Sonora">×</button></header>
      <section class="heading"><p class="eyebrow">CLICK PAGE TEXT TO READ</p><h2></h2><p class="meta"></p></section>
      <div class="status"><i class="dot"></i><span></span></div>
      <section class="controls" aria-label="Voice controls"><label>Voice<select class="voice" aria-label="Voice"><option value="af_heart">Heart · warm</option><option value="af_bella">Bella · clear</option></select></label><label>Speed<select class="speed" aria-label="Speed"><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="2.25">2.25×</option><option value="2.5">2.5×</option><option value="2.75">2.75×</option><option value="3">3×</option></select></label></section>
      <section class="selection" aria-label="Reading instructions"><p class="selection-title">Page reader ready</p><p class="selection-copy">Click any highlighted text block, table cell, or heading on the page to start there. Keep scrolling and choose another block whenever you want.</p></section>
      <footer class="bottom"><div class="transport"><button class="stop" type="button">Stop</button><button class="play" type="button"><span class="play-icon">▶</span> <span class="play-label">Play from top</span></button></div><div class="track" aria-hidden="true"><i></i></div><p class="hint">Your page stays in place while Sonora reads.</p></footer>
      <audio preload="auto"></audio>
    </aside>`;
  let trustedPanelMarkup = panelMarkup;
  try {
    const policyName = `sonora-extension-${Math.random().toString(36).slice(2)}`;
    const policy = globalThis.trustedTypes?.createPolicy?.(policyName, { createHTML: value => value });
    if (policy) trustedPanelMarkup = policy.createHTML(panelMarkup);
  } catch { /* Pages without Trusted Types accept the original string. */ }
  shadow.innerHTML = trustedPanelMarkup;

  const attachRoot = () => {
    const host = document.documentElement || document.body;
    if (!host) return false;
    host.append(root);
    return true;
  };
  if (!attachRoot()) document.addEventListener('DOMContentLoaded', attachRoot, { once: true });
  const els = {
    panel: shadow.querySelector('.panel'), title: shadow.querySelector('h2'), meta: shadow.querySelector('.meta'), status: shadow.querySelector('.status span'), dot: shadow.querySelector('.dot'),
    voice: shadow.querySelector('.voice'), speed: shadow.querySelector('.speed'), play: shadow.querySelector('.play'), playIcon: shadow.querySelector('.play-icon'), playLabel: shadow.querySelector('.play-label'), stop: shadow.querySelector('.stop'), track: shadow.querySelector('.track i'), audio: shadow.querySelector('audio'), minimize: shadow.querySelector('.minimize'), close: shadow.querySelector('.close')
  };
  const state = {
    index: -1,
    queue: [],
    rendered: new Map(),
    ready: false,
    playing: false,
    revision: 0,
    pendingStart: null,
    pendingRender: false,
    completed: false,
    audioRevision: 0,
    audioObjectUrl: null,
    audioContext: null,
    webAudioBuffer: null,
    webAudioSourceData: null,
    webAudioSource: null,
    webAudioStartedAt: 0,
    webAudioOffset: 0,
    webAudioTimer: null,
    webAudioRate: 1,
    webAudioRun: 0,
    tempoBuffer: null,
    tempoRate: null,
    voiceTimer: null,
    closed: false,
    status: 'Checking the local voice…'
  };
  let refreshTimer = null;
  let sourceUrl = location.href;
  const navigationTimer = setInterval(() => {
    if (sourceUrl !== location.href) scheduleBlockRefresh();
  }, 1000);
  const knownBlocks = new Set();
  const wordTracker = window.SonoraWords.createTracker(document, shadow);
  const codeRange = window.SonoraWords.createRangeResolver(document);
  let wordFrame = null;
  const changedSettings = new Set();
  const pageClass = PAGE_CLASS;
  const currentClass = CURRENT_CLASS;
  let docsHover = null;
  let codeHoverPoint = null;
  els.audio.preservesPitch = true;

  els.title.textContent = source.title || document.title || 'Untitled page';
  els.meta.textContent = `${blockEntries.length} clickable ${blockEntries.length === 1 ? 'block' : 'blocks'} · ${pageText.length.toLocaleString()} characters${source.truncated ? ' · first 240,000 shown' : ''}`;

  function setStatus(message, mode = '') { state.status = message; els.status.textContent = message; els.dot.className = `dot ${mode}`; }
  function readyMessage() {
    if (isGoogleDocsPage() && !blockEntries.length) return 'Refresh this Google Doc once to enable passage highlights.';
    return 'Ready — click page text to begin.';
  }
  function saveSetting(key, value) {
    changedSettings.add(key);
    try {
      const result = chrome.storage?.local?.set({ [key]: value });
      result?.catch?.(() => {});
    } catch { /* Storage can be unavailable in restricted test pages. */ }
  }
  function loadSettings() {
    try {
      const storage = chrome.storage?.local;
      if (!storage?.get) return;
      Promise.resolve(storage.get(['sonoraSpeed', 'sonoraVoice'])).then(saved => {
        if (state.closed) return;
        if (!changedSettings.has('sonoraSpeed') && saved?.sonoraSpeed !== undefined && [...els.speed.options].some(option => option.value === String(saved.sonoraSpeed))) els.speed.value = String(saved.sonoraSpeed);
        if (!changedSettings.has('sonoraVoice') && saved?.sonoraVoice && [...els.voice.options].some(option => option.value === saved.sonoraVoice)) els.voice.value = saved.sonoraVoice;
      }).catch(() => {});
    } catch { /* Storage can be unavailable in restricted test pages. */ }
  }
  function message(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, response => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else if (!response?.ok) reject(new Error(response?.error || 'Sonora could not complete the request.'));
          else resolve(response.data);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  function clearCurrentBlock() {
    blockEntries.forEach(entry => (entry.nodes || [entry.node]).forEach(node => node.classList.remove(currentClass)));
    window.CSS?.highlights?.delete('sonora-current-code');
  }
  function markCodePart(entry, part, name) {
    const highlights = window.CSS?.highlights;
    if (!highlights || !window.Highlight) return;
    const range = part && codeRange(entry, part.offset, part.text.length);
    if (range) {
      const highlight = new Highlight(range);
      highlight.priority = name === 'sonora-current-code' ? 1 : 0;
      highlights.set(name, highlight);
    } else highlights.delete(name);
  }
  function codePartAt(entry, x, y) {
    const bounds = entry.contentNode.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    let nearest = null, distance = Infinity;
    for (const part of entry.parts) {
      const range = codeRange(entry, part.offset, part.text.length);
      for (const rect of range?.getClientRects() || []) {
        if (rect.width <= 0 || rect.height <= 0 || y < rect.top || y > rect.bottom) continue;
        const gap = Math.max(rect.left - x, x - rect.right, 0);
        if (!gap) return part;
        if (gap < distance) { nearest = part; distance = gap; }
      }
    }
    return nearest;
  }
  function updateCodeHover() {
    const point = codeHoverPoint;
    const block = point && document.elementFromPoint(point.x, point.y)?.closest('.sonora-code-block');
    const entry = block && blockEntries.find(candidate => candidate.node === block);
    markCodePart(entry, entry && codePartAt(entry, point.x, point.y), 'sonora-hover-code');
  }
  function currentEntry() {
    const item = state.queue[state.index];
    return item && blockEntries.find(entry => item.blockKey ? entry.key === item.blockKey : entry.index === item.blockIndex);
  }
  function paintCurrentWord() {
    const position = state.webAudioBuffer ? webAudioPosition() : els.audio.currentTime;
    wordTracker.update(currentEntry(), position, isGoogleDocsPage() ? googleDocsSurface(source.root) : null);
  }
  function stopWordFrames() {
    if (wordFrame !== null) cancelAnimationFrame(wordFrame);
    wordFrame = null;
  }
  function startWordFrames() {
    stopWordFrames();
    const tick = () => {
      wordFrame = null;
      if (state.closed || !state.playing) return;
      paintCurrentWord();
      wordFrame = requestAnimationFrame(tick);
    };
    wordFrame = requestAnimationFrame(tick);
  }
  function resetWords() { stopWordFrames(); wordTracker.reset(); }
  function markCurrentBlock(blockIndex, blockKey) {
    clearCurrentBlock();
    const entry = blockEntries.find(candidate => blockKey ? candidate.key === blockKey : candidate.index === blockIndex);
    if (entry) (entry.nodes || [entry.node]).forEach(node => node.classList.add(currentClass));
    const item = state.queue[state.index];
    if (entry?.kind === 'code' && item) markCodePart(entry, { text: item.text, offset: item.blockOffset }, 'sonora-current-code');
  }
  function updateTransport() {
    els.playIcon.textContent = state.playing ? 'Ⅱ' : '▶';
    els.playLabel.textContent = state.playing || state.pendingRender || state.pendingStart !== null ? 'Pause' : (state.index >= 0 && !state.completed ? 'Resume' : 'Play from top');
    els.play.classList.toggle('is-playing', state.playing);
  }
  function releaseAudioObjectUrl() {
    if (!state.audioObjectUrl) return;
    URL.revokeObjectURL(state.audioObjectUrl);
    state.audioObjectUrl = null;
  }
  function primeAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      if (!state.audioContext) state.audioContext = new AudioContextClass();
      // Calling resume during the user's click keeps the context usable after
      // the asynchronous local render completes.
      state.audioContext.resume().catch(() => {});
      return state.audioContext;
    } catch {
      return null;
    }
  }
  function clearWebAudioTimer() {
    if (!state.webAudioTimer) return;
    clearInterval(state.webAudioTimer);
    state.webAudioTimer = null;
  }
  function webAudioPosition() {
    if (!state.webAudioSource || !state.webAudioBuffer || !state.audioContext) return state.webAudioOffset;
    const rate = state.webAudioRate;
    return Math.min(state.webAudioBuffer.duration, state.webAudioOffset + (state.audioContext.currentTime - state.webAudioStartedAt) * rate);
  }
  function updateProgress(position = state.webAudioOffset) {
    const duration = state.webAudioBuffer?.duration || 0;
    const part = duration ? position / duration : 0;
    els.track.style.width = `${Math.min(100, ((state.index + part) / Math.max(1, state.queue.length)) * 100)}%`;
  }
  function pauseWebAudio() {
    state.webAudioRun++;
    if (!state.webAudioSource) return;
    state.webAudioOffset = webAudioPosition();
    const source = state.webAudioSource;
    state.webAudioSource = null;
    source.onended = null;
    try { source.stop(); } catch {}
    source.disconnect();
    clearWebAudioTimer();
  }
  function resetWebAudio() {
    pauseWebAudio();
    state.webAudioBuffer = null;
    state.webAudioSourceData = null;
    state.webAudioOffset = 0;
    state.tempoBuffer = null;
    state.tempoRate = null;
  }
  function bytesFromDataSource(source) {
    const comma = source.indexOf(',');
    if (comma < 0 || !source.slice(0, comma).includes(';base64')) throw new Error('Sonora returned an invalid audio source.');
    const binary = atob(source.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  async function playWebAudio(source, revision, offset = 0) {
    pauseWebAudio();
    const run = state.webAudioRun;
    const context = primeAudioContext();
    if (!context) throw new Error('This browser cannot play Sonora audio.');
    await context.resume();
    if (revision !== state.revision || run !== state.webAudioRun) return false;
    if (!state.webAudioBuffer || state.webAudioSourceData !== source) {
      const bytes = bytesFromDataSource(source);
      const decoded = await context.decodeAudioData(bytes.buffer.slice(0));
      if (revision !== state.revision || run !== state.webAudioRun) return false;
      state.webAudioBuffer = decoded;
      state.webAudioSourceData = source;
      state.tempoBuffer = null;
      state.tempoRate = null;
    }
    if (revision !== state.revision || run !== state.webAudioRun) return false;
    const buffer = state.webAudioBuffer;
    const rate = Number(els.speed.value) || 1;
    if (!state.tempoBuffer || state.tempoRate !== rate) {
      if (rate === 1) state.tempoBuffer = buffer;
      else {
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
        const stretched = window.SonoraTempo.stretch(channels, buffer.sampleRate, rate);
        const tempoBuffer = context.createBuffer(stretched.length, stretched[0].length, buffer.sampleRate);
        stretched.forEach((channel, index) => tempoBuffer.copyToChannel(channel, index));
        state.tempoBuffer = tempoBuffer;
      }
      state.tempoRate = rate;
    }
    const sourceNode = context.createBufferSource();
    const startOffset = Math.max(0, Math.min(Number(offset) || 0, Math.max(0, buffer.duration - 0.001)));
    sourceNode.buffer = state.tempoBuffer;
    sourceNode.playbackRate.value = 1;
    sourceNode.connect(context.destination);
    state.webAudioSource = sourceNode;
    state.webAudioStartedAt = context.currentTime;
    state.webAudioOffset = startOffset;
    state.webAudioRate = rate;
    sourceNode.onended = () => {
      if (state.webAudioSource !== sourceNode) return;
      sourceNode.disconnect();
      state.webAudioSource = null;
      state.webAudioOffset = 0;
      clearWebAudioTimer();
      advanceQueue(revision);
    };
    sourceNode.start(0, startOffset / rate);
    // A stop or a new page selection can happen in the same turn as start().
    // Tear down a stale source before it gets a chance to speak.
    if (revision !== state.revision || run !== state.webAudioRun) {
      sourceNode.onended = null;
      try { sourceNode.stop(); } catch {}
      if (state.webAudioSource === sourceNode) state.webAudioSource = null;
      clearWebAudioTimer();
      return false;
    }
    clearWebAudioTimer();
    state.webAudioTimer = setInterval(() => updateProgress(webAudioPosition()), 50);
    return true;
  }
  function pausePlayback() {
    stopWordFrames();
    pauseWebAudio();
    els.audio.pause();
    if (state.pendingRender) {
      // A render may still be waiting on the local model. Invalidate that
      // request so its eventual response cannot start playback after pause.
      state.revision++;
      state.pendingRender = false;
    }
    state.playing = false;
    if (state.index >= 0 && !state.completed) paintCurrentWord();
    updateTransport();
  }
  function pageAudioSource(source) {
    if (typeof source !== 'string' || !source.startsWith('data:')) return source;
    const comma = source.indexOf(',');
    if (comma < 0 || !source.slice(0, comma).includes(';base64')) return source;
    const metadata = source.slice(5, comma).split(';');
    const mime = metadata[0] || 'audio/wav';
    const binary = atob(source.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    state.audioObjectUrl = objectUrl;
    return objectUrl;
  }
  function queueFrom(blockIndex = 0, limit = MAX_PAGE_CHARS, blockOffset = 0) {
    const queue = [];
    let remaining = limit;
    for (const entry of blockEntries) {
      if (entry.index < blockIndex || remaining <= 0) continue;
      const blockText = entry.text.slice(0, remaining);
      const pieces = entry.kind === 'code' ? null : chunksFor(blockText, 1200);
      const offsets = pieces && window.SonoraWords.chunkOffsets(blockText, pieces);
      const chunks = entry.kind === 'code' ? window.SonoraPassages.codePassages(blockText, chunksFor)
        : pieces.map((text, at) => ({ text, offset: offsets[at] }));
      chunks.filter(part => entry.index !== blockIndex || part.offset >= blockOffset)
        .forEach(part => queue.push({ text: part.text, blockIndex: entry.index, blockKey: entry.key, blockOffset: part.offset }));
      remaining -= blockText.length;
    }
    if (!queue.length && blockIndex === 0 && pageText && !isGoogleDocsPage()) {
      chunksFor(pageText, 1200).forEach(chunk => queue.push({ text: chunk, blockIndex: null }));
    }
    return queue;
  }
  function render(index) {
    const item = state.queue[index];
    if (!item) return Promise.reject(new Error('No readable passage is selected.'));
    if (state.rendered.has(index)) return state.rendered.get(index);
    const promise = message({ type: 'sonora-render', text: item.text, voice: els.voice.value });
    state.rendered.set(index, promise);
    promise.catch(() => { if (state.rendered.get(index) === promise) state.rendered.delete(index); });
    return promise;
  }
  function trimRendered(index) {
    for (const key of state.rendered.keys()) {
      if (key < index || key > index + 1) state.rendered.delete(key);
    }
  }
  async function play(index = state.index < 0 ? 0 : state.index) {
    const item = state.queue[index];
    if (!item || !state.ready) return;
    const revision = ++state.revision;
    state.index = index;
    state.completed = false;
    state.playing = false;
    state.pendingRender = true;
    resetWords();
    els.audio.pause();
    resetWebAudio();
    releaseAudioObjectUrl();
    els.audio.removeAttribute('src');
    els.audio.load();
    trimRendered(index);
    markCurrentBlock(item.blockIndex, item.blockKey);
    updateTransport();
    els.track.style.width = '0%';
    setStatus(`Rendering passage ${index + 1} of ${state.queue.length}…`, 'busy');
    try {
      const result = await render(index);
      if (revision !== state.revision) return;
      if (!result || typeof result.src !== 'string' || !result.src) {
        throw new Error('Sonora returned no playable audio.');
      }
      wordTracker.prepare(currentEntry(), item, result.words);
      els.audio.pause();
      releaseAudioObjectUrl();
      resetWebAudio();
      const canUseWebAudio = typeof result.src === 'string' && result.src.startsWith('data:') && (window.AudioContext || window.webkitAudioContext);
      if (canUseWebAudio) {
        try {
          if (!await playWebAudio(result.src, revision)) return;
        } catch (webAudioError) {
          if (revision !== state.revision) return;
          // Keep a native-media fallback for browsers with an unusual WAV
          // decoder or a disabled Web Audio output device.
          resetWebAudio();
          state.audioRevision = revision;
          els.audio.src = pageAudioSource(result.src);
          els.audio.currentTime = 0;
          els.audio.playbackRate = Number(els.speed.value);
          await els.audio.play().catch(error => { throw error || webAudioError; });
        }
      } else {
        state.audioRevision = revision;
        els.audio.src = pageAudioSource(result.src);
        els.audio.currentTime = 0;
        els.audio.playbackRate = Number(els.speed.value);
        await els.audio.play();
      }
      if (revision !== state.revision) return;
      state.pendingRender = false;
      state.playing = true;
      startWordFrames();
      setStatus(`Playing passage ${index + 1} of ${state.queue.length}`, 'ready');
      updateTransport();
      if (index + 1 < state.queue.length) render(index + 1).catch(() => {});
    } catch (error) {
      if (revision !== state.revision) return;
      state.pendingRender = false;
      state.playing = false;
      updateTransport();
      setStatus(error.name === 'NotAllowedError' ? 'Audio is ready. Press play to start.' : error.message, 'error');
    }
  }
  function startQueue(blockIndex = 0, blockOffset = 0) {
    const queue = queueFrom(blockIndex, MAX_PAGE_CHARS, blockOffset);
    if (!queue.length) {
      setStatus(isGoogleDocsPage() ? readyMessage() : 'No readable text was found in that block.', 'error');
      return;
    }
    primeAudioContext();
    state.revision++;
    state.queue = queue;
    const startIndex = 0;
    state.rendered.clear();
    state.index = -1;
    state.playing = false;
    state.pendingRender = false;
    state.completed = false;
    state.pendingStart = 0;
    resetWords();
    els.audio.pause();
    resetWebAudio();
    releaseAudioObjectUrl();
    els.audio.removeAttribute('src');
    els.audio.load();
    els.track.style.width = '0%';
    clearCurrentBlock();
    updateTransport();
    if (state.ready) {
      state.pendingStart = null;
      play(startIndex);
    } else {
      state.pendingStart = startIndex;
      setStatus('Waiting for the local voice to finish warming up…', 'busy');
    }
  }
  function stop() {
    resetWords();
    state.revision++;
    state.pendingStart = null;
    state.pendingRender = false;
    state.playing = false;
    state.index = -1;
    state.completed = false;
    els.audio.pause();
    resetWebAudio();
    releaseAudioObjectUrl();
    els.audio.removeAttribute('src');
    els.audio.load();
    els.track.style.width = '0%';
    clearCurrentBlock();
    updateTransport();
    if (state.ready) setStatus(readyMessage(), blockEntries.length ? 'ready' : 'error');
  }
  async function checkVoice() {
    if (state.closed) return;
    if (state.voiceTimer) { clearTimeout(state.voiceTimer); state.voiceTimer = null; }
    try {
      const data = await message({ type: 'sonora-status' });
      if (state.closed) return;
      state.ready = Boolean(data.ready);
      if (data.ready) {
        setStatus(readyMessage(), isGoogleDocsPage() && !blockEntries.length ? 'error' : 'ready');
        if (state.pendingStart !== null && state.queue.length) {
          const pending = state.pendingStart;
          state.pendingStart = null;
          play(pending);
        }
      } else if (data.state === 'loading') {
        setStatus('Warming up the local voice…', 'busy');
        state.voiceTimer = setTimeout(() => { state.voiceTimer = null; checkVoice(); }, 2500);
      } else {
        setStatus(data.message || 'Start Sonora with npm start.', 'error');
        // Keep checking so installing or restarting the local model takes
        // effect without requiring the page reader to be reopened.
        state.voiceTimer = setTimeout(() => { state.voiceTimer = null; checkVoice(); }, 5000);
      }
    } catch {
      if (state.closed) return;
      state.ready = false;
      setStatus('Sonora is offline — start npm start in book-to-voice.', 'error');
      state.voiceTimer = setTimeout(() => { state.voiceTimer = null; checkVoice(); }, 3000);
    }
  }
  function handlePageClick(event, block) {
    if ((event.defaultPrevented && !isGoogleDocsPage()) || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button,input,textarea,select,summary,[role="button"]')) return;
    if (target?.closest('a,[role="link"]')) {
      event.preventDefault();
      event.stopPropagation();
    }
    const entry = blockEntries.find(candidate => candidate.node === block || candidate.nodes?.includes(block));
    if (!entry) return;
    const part = entry.kind === 'code' && event.detail !== 0 ? codePartAt(entry, event.clientX, event.clientY) : null;
    if (entry.kind === 'code' && event.detail !== 0 && !part) return;
    if (isGoogleDocsPage()) {
      event.preventDefault();
      event.stopPropagation();
    }
    startQueue(entry.index, part?.offset || 0);
  }
  function updateBlocks(nextBlocks, navigated = false) {
    const nextEntries = makeBlockEntries(nextBlocks);
    const activeItem = state.queue[state.index >= 0 ? state.index : (state.pendingStart ?? 0)];
    const activeEntry = activeItem && nextEntries.find(entry => entry.key === activeItem.blockKey);
    const edited = !isGoogleDocsPage() && activeEntry && !window.SonoraPassages.matchesPassage(activeEntry, activeItem);
    const changed = isGoogleDocsPage() ? docsDocumentChanged : navigated || edited;
    if (changed && state.queue.length) {
      // Keep the selected queue through unrelated updates and DOM redraws.
      // A new page or an edit to the spoken text ends the old session.
      state.revision++;
      state.pendingStart = null;
      state.pendingRender = false;
      state.playing = false;
      state.index = -1;
      state.completed = false;
      state.queue = [];
      resetWords();
      state.rendered.clear();
      els.audio.pause();
      resetWebAudio();
      releaseAudioObjectUrl();
      els.audio.removeAttribute('src');
      els.audio.load();
      els.track.style.width = '0%';
      clearCurrentBlock();
      updateTransport();
      if (state.ready) setStatus(edited ? 'This passage changed — click it to read the updated text.' : readyMessage(), 'ready');
    }
    const nextNodes = new Set(nextEntries.flatMap(entry => entry.nodes || [entry.node]));
    knownBlocks.forEach(node => {
      if (!nextNodes.has(node)) {
        node.classList.remove(pageClass, currentClass, 'sonora-docs-passage', 'sonora-hover-block', 'sonora-code-block');
        knownBlocks.delete(node);
      }
    });
    nextEntries.forEach(entry => (entry.nodes || [entry.node]).forEach(node => {
      node.classList.add(pageClass);
      node.classList.toggle('sonora-code-block', entry.kind === 'code');
      if (isGoogleDocsPage()) node.classList.add('sonora-docs-passage');
      knownBlocks.add(node);
    }));
    blockEntries = nextEntries;
    if (!isGoogleDocsPage()) updateCodeHover();
    if (!changed && isGoogleDocsPage() && state.queue.length) {
      // Continue through newly rendered pages after the queued snapshot. Keys
      // survive tile replacement and index shifts from earlier discoveries.
      const last = blockEntries.find(entry => entry.key === state.queue.at(-1).blockKey);
      if (last) {
        const remaining = MAX_PAGE_CHARS - state.queue.reduce((count, item) => count + item.text.length, 0);
        const queued = new Set(state.queue.map(item => item.blockKey));
        const added = queueFrom(last.index + 1, Math.max(0, remaining)).filter(item => !queued.has(item.blockKey));
        state.queue.push(...added);
        if (added.length && state.playing && state.index + 1 < state.queue.length) render(state.index + 1).catch(() => {});
      }
    }
    if (!changed && state.index >= 0) {
      const item = state.queue[state.index];
      markCurrentBlock(item?.blockIndex, item?.blockKey);
      if (!state.completed) paintCurrentWord();
    }
    const updatedText = cleanText(nextEntries.map(entry => entry.text).join('\n\n'));
    pageText = (updatedText || cleanText(source.text)).slice(0, MAX_PAGE_CHARS);
    els.meta.textContent = `${blockEntries.length} clickable ${blockEntries.length === 1 ? 'block' : 'blocks'} · ${pageText.length.toLocaleString()} characters${source.truncated ? ' · first 240,000 shown' : ''}`;
    if (isGoogleDocsPage() && state.ready && !state.queue.length) setStatus(readyMessage(), blockEntries.length ? 'ready' : 'error');
  }
  function refreshBlocks() {
    refreshTimer = null;
    const navigated = !isGoogleDocsPage() && window.SonoraPassages.pageIdentity(sourceUrl) !== window.SonoraPassages.pageIdentity(location.href);
    if (navigated) { pageEntries = []; reconcileEntries = window.SonoraPassages.createReconciler(); }
    if (sourceUrl !== location.href || !source.root?.isConnected) {
      const nextSource = findReadableSource();
      sourceUrl = location.href;
      source.root = nextSource.root;
      source.text = nextSource.text;
      source.title = nextSource.title;
      source.truncated = nextSource.truncated;
      source.noiseSelector = nextSource.noiseSelector;
      els.title.textContent = source.title || document.title || 'Untitled page';
    }
    const nextBlocks = selectReadableBlocks(source.root, source.noiseSelector);
    updateBlocks(nextBlocks, navigated);
  }
  function scheduleBlockRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(refreshBlocks, 500);
  }
  updateBlocks(source.blocks);
  const pageClickListener = event => {
    if (!(event.target instanceof Element)) return;
    if (event.target === root || root.contains(event.target)) return;
    if (isGoogleDocsPage()) {
      const surface = googleDocsSurface(source.root);
      if (!surface?.closest('.kix-appview-editor')?.contains(event.target)) return;
      const entry = window.SonoraDocs.hitTest(blockEntries, event.clientX, event.clientY);
      // Playback starts on pointerdown before Docs can replace the clicked
      // annotation during its own selection gesture. Consume the later click.
      if (entry) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    const block = event.target.closest(`.${pageClass}`);
    if (!block || !source.root?.contains(block)) return;
    handlePageClick(event, block);
  };
  document.addEventListener('click', pageClickListener, true);
  const docsPointerDownListener = event => {
    if (!isGoogleDocsPage() || event.target === root) return;
    const surface = googleDocsSurface(source.root);
    if (!surface?.closest('.kix-appview-editor')?.contains(event.target)) return;
    const entry = window.SonoraDocs.hitTest(blockEntries, event.clientX, event.clientY);
    if (entry) handlePageClick(event, entry.node);
  };
  document.addEventListener('pointerdown', docsPointerDownListener, true);
  const docsPointerListener = event => {
    if (!isGoogleDocsPage()) {
      codeHoverPoint = { x: event.clientX, y: event.clientY };
      updateCodeHover();
      return;
    }
    const surface = googleDocsSurface(source.root);
    const next = surface?.closest('.kix-appview-editor')?.contains(event.target) ? window.SonoraDocs.hitTest(blockEntries, event.clientX, event.clientY) : null;
    if (docsHover === next) return;
    docsHover?.nodes.forEach(node => node.classList.remove('sonora-hover-block'));
    docsHover = next;
    docsHover?.nodes.forEach(node => node.classList.add('sonora-hover-block'));
  };
  document.addEventListener('pointermove', docsPointerListener, true);
  const wordPositionListener = () => {
    if (!state.playing && state.index >= 0 && !state.completed) paintCurrentWord();
    if (!isGoogleDocsPage()) updateCodeHover();
  };
  document.addEventListener('scroll', wordPositionListener, true);
  window.addEventListener('resize', wordPositionListener);
  window.addEventListener('popstate', scheduleBlockRefresh);
  window.addEventListener('hashchange', scheduleBlockRefresh);
  const pageObserver = new MutationObserver(scheduleBlockRefresh);
  const observeSource = () => {
    // Observe the document rather than one article node. SPA navigation and
    // editors commonly replace the readable root in place.
    const rootNode = document.body || document.documentElement || source.root;
    if (!rootNode) return false;
    pageObserver.observe(rootNode, { childList: true, subtree: true, characterData: true });
    return true;
  };
  if (!observeSource()) {
    document.addEventListener('DOMContentLoaded', () => {
      if (!observeSource()) return;
      if (!source.root?.isConnected) {
        const nextSource = findReadableSource();
        sourceUrl = location.href;
        source.root = nextSource.root;
        source.text = nextSource.text;
        source.title = nextSource.title;
        source.truncated = nextSource.truncated;
        source.noiseSelector = nextSource.noiseSelector;
        els.title.textContent = source.title || document.title || 'Untitled page';
      }
      updateBlocks(selectReadableBlocks(source.root, source.noiseSelector));
    }, { once: true });
  }
  els.play.addEventListener('click', () => {
    if (state.playing || state.pendingRender || state.pendingStart !== null) {
      state.pendingStart = null;
      pausePlayback();
      state.playing = false;
      updateTransport();
      setStatus('Paused', 'ready');
    } else if (!state.completed && state.webAudioBuffer && state.index >= 0) {
      const revision = state.revision;
      playWebAudio(state.webAudioSourceData, revision, state.webAudioOffset).then(started => {
        if (!started || revision !== state.revision || state.closed) return;
        state.playing = true;
        startWordFrames();
        updateTransport();
        setStatus(`Playing passage ${state.index + 1} of ${state.queue.length}`, 'ready');
      }).catch(error => {
        if (revision === state.revision && !state.closed) setStatus(error.message, 'error');
      });
    } else if (!state.completed && els.audio.src && state.index >= 0) {
      const revision = state.revision;
      els.audio.play().then(() => {
        if (revision !== state.revision || state.closed) return;
        state.playing = true;
        startWordFrames();
        updateTransport();
        setStatus(`Playing passage ${state.index + 1} of ${state.queue.length}`, 'ready');
      }).catch(error => {
        if (revision === state.revision && !state.closed) setStatus(error.message, 'error');
      });
    } else if (state.queue.length) {
      const resumeIndex = state.index >= 0 && !state.completed ? state.index : 0;
      state.pendingStart = resumeIndex;
      if (state.ready) { state.pendingStart = null; play(resumeIndex); }
      else setStatus('Waiting for the local voice to finish warming up…', 'busy');
    } else startQueue(0);
  });
  els.stop.addEventListener('click', stop);
  els.audio.addEventListener('timeupdate', () => {
    const part = els.audio.duration ? els.audio.currentTime / els.audio.duration : 0;
    els.track.style.width = `${Math.min(100, ((state.index + part) / Math.max(1, state.queue.length)) * 100)}%`;
  });
  els.audio.addEventListener('ended', () => {
    if (state.audioRevision === state.revision) advanceQueue(state.revision);
  });
  els.audio.addEventListener('error', () => {
    if (state.closed || !els.audio.src || state.audioRevision !== state.revision || state.webAudioSource) return;
    state.playing = false;
    updateTransport();
    setStatus('Sonora audio could not be decoded by this browser.', 'error');
  });
  function advanceQueue(revision = state.revision) {
    if (revision !== state.revision) return;
    state.playing = false;
    if (state.index + 1 < state.queue.length) play(state.index + 1);
    else {
      state.pendingRender = false;
      state.completed = true;
      resetWords();
      els.track.style.width = '100%';
      updateTransport();
      setStatus('Page section complete — click another block to jump.', 'ready');
    }
  }
  els.speed.addEventListener('change', () => {
    const rate = Number(els.speed.value) || 1;
    saveSetting('sonoraSpeed', rate);
    els.audio.playbackRate = rate;
    if (state.webAudioSource || (state.playing && state.webAudioBuffer)) {
      pauseWebAudio();
      const revision = state.revision;
      playWebAudio(state.webAudioSourceData, revision, state.webAudioOffset).catch(error => {
        if (revision !== state.revision || state.closed) return;
        state.playing = false;
        updateTransport();
        setStatus(error.message, 'error');
      });
    }
  });
  els.voice.addEventListener('change', () => {
    saveSetting('sonoraVoice', els.voice.value);
    const item = state.queue[state.index];
    const currentBlock = item?.blockKey ? blockEntries.find(entry => entry.key === item.blockKey)?.index : item?.blockIndex;
    const hadQueue = state.queue.length > 0;
    stop();
    state.rendered.clear();
    if (currentBlock !== undefined) startQueue(currentBlock);
    else if (hadQueue) startQueue(0);
  });
  els.minimize.addEventListener('click', () => els.panel.classList.toggle('is-hidden'));
  els.close.addEventListener('click', () => {
    resetWords();
    state.closed = true;
    state.revision++;
    els.audio.pause();
    resetWebAudio();
    state.audioContext?.close().catch(() => {});
    state.audioContext = null;
    releaseAudioObjectUrl();
    pageObserver.disconnect();
    document.removeEventListener('click', pageClickListener, true);
    document.removeEventListener('pointerdown', docsPointerDownListener, true);
    document.removeEventListener('pointermove', docsPointerListener, true);
    document.removeEventListener('scroll', wordPositionListener, true);
    window.removeEventListener('resize', wordPositionListener);
    window.removeEventListener('popstate', scheduleBlockRefresh);
    window.removeEventListener('hashchange', scheduleBlockRefresh);
    if (refreshTimer) clearTimeout(refreshTimer);
    clearInterval(navigationTimer);
    if (state.voiceTimer) clearTimeout(state.voiceTimer);
    knownBlocks.forEach(node => node.classList.remove(pageClass, currentClass, 'sonora-docs-passage', 'sonora-hover-block', 'sonora-code-block'));
    window.CSS?.highlights?.delete('sonora-hover-code');
    clearCurrentBlock();
    root.remove();
    delete window.__sonoraOverlay;
  });
  window.__sonoraOverlay = {
    version: OVERLAY_VERSION,
    toggle: () => els.panel.classList.toggle('is-hidden'),
    dispose: () => els.close.click()
  };
  loadSettings();
  checkVoice();

  function readableText(node) {
    if (!node) return '';
    if (node.matches?.('pre')) node = node.querySelector('code') || node;
    if (isGoogleDocsPage() && node.matches?.('g[role="paragraph"]')) {
      return cleanText([...node.querySelectorAll('rect[aria-label]')].map(rect => rect.getAttribute('aria-label')).join(' '));
    }
    return window.SonoraPassages.readableText(node, cleanText);
  }

  function isGoogleDocsPage() {
    return /(^|\.)docs\.google\.com$/i.test(location.hostname) && /^\/document\//.test(location.pathname);
  }

  function googleDocsSurface(root) {
    return window.SonoraDocs.surfaceFor(root);
  }

  function makeBlockEntries(nodes) {
    if (isGoogleDocsPage()) {
      const surface = googleDocsSurface(document);
      docsDocumentChanged = Boolean(surface && docsSurface && surface !== docsSurface);
      if (docsDocumentChanged) docsEntries = [];
      if (surface) docsSurface = surface;
      docsEntries = window.SonoraDocs.mergePassages(docsEntries, window.SonoraDocs.passages(surface, cleanText), cleanText);
      return docsEntries;
    }
    const incoming = nodes.map(node => {
      const text = readableText(node);
      return { node, text, scope: window.SonoraPassages.scopeFor(node), ...(node.matches('pre')
        ? { kind: 'code', contentNode: node.querySelector('code') || node, parts: window.SonoraPassages.codePassages(text, chunksFor) } : {}) };
    })
      .filter(entry => entry.kind === 'code' ? entry.parts.length > 0
        : entry.text.length > (entry.node.matches('td, th, [role="cell"], [role="gridcell"]') ? 0 : 1));
    pageEntries = reconcileEntries(pageEntries, incoming);
    return pageEntries;
  }

  function selectReadableBlocks(root, noiseSelector) {
    if (!root) return [];
    if (isGoogleDocsPage()) {
      const surface = googleDocsSurface(root);
      return surface ? [...surface.querySelectorAll('svg g[role="paragraph"]')].filter(node => node.querySelector('rect[aria-label]')) : [];
    }
    const semanticSelector = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, caption, li, dt, dd, [role="cell"], [role="gridcell"]';
    const customSelector = [
      '.kix-paragraphrenderer', '.kix-lineview', '.kix-lineview-content', '.kix-page',
      '[data-block-id]', '[data-slate-node="element"]', '[data-lexical-node="true"]',
      '[data-testid*="paragraph" i]', '[role="heading"]', '[role="paragraph"]', '[role="article"]', '[role="listitem"]'
    ].join(',');
    const accessibleTextSelector = [
      '.kix-wordhtmlgenerator-word-node', '.kix-lineview-text-block', '[role="text"]',
      'span[aria-label]', '[aria-label]:not([role="button"])'
    ].join(',');
    const semantic = [...root.querySelectorAll(semanticSelector)];
    const googleParagraphs = [...root.querySelectorAll('.kix-paragraphrenderer')];
    const googleLines = [...root.querySelectorAll('.kix-lineview')];
    const googleLineContent = [...root.querySelectorAll('.kix-lineview-content')];
    const googlePages = [...root.querySelectorAll('.kix-page')];
    const custom = [...root.querySelectorAll(customSelector)]
      .filter(node => !node.matches('.kix-lineview, .kix-paragraphrenderer'));
    const googleBlocks = googleParagraphs.length ? googleParagraphs
      : googleLines.length ? googleLines
        : googleLineContent.length ? googleLineContent
          : googlePages;
    const raw = [...new Set([...semantic, ...googleBlocks, ...custom])];
    const blocks = raw.filter(block => {
      if (block.closest(noiseSelector) || !window.SonoraPassages.visibleBlock(block)) return false;
      if (window.SonoraPassages.isCodeChrome(block, root)) return false;
      if (!block.matches('pre') && block.closest('pre')) return false;
      const value = readableText(block);
      if (value.length <= (block.matches('pre, td, th, [role="cell"], [role="gridcell"]') ? 0 : 1)) return false;
      if (block.matches('pre') && !/[\p{L}\p{N}]/u.test(value)) return false;
      if (block.matches('.kix-page') && (googleParagraphs.length || googleLines.length || googleLineContent.length)) return false;
      if (block.matches('.kix-lineview') && block.closest('.kix-paragraphrenderer')) return false;
      if (block.matches('.kix-lineview-content') && block.closest('.kix-lineview')) return false;
      if (block.matches('p, h1, h2, h3, h4, h5, h6, blockquote, pre') && block.closest('td, th, [role="cell"], [role="gridcell"]')) return false;
      if (block.matches('li, dt, dd') && block.querySelector('p, h1, h2, h3, h4, h5, h6, blockquote, pre')) return false;
      if (block.matches('blockquote') && block.querySelector('p,blockquote')) return false;
      if (block.matches(customSelector) && !block.matches('.kix-paragraphrenderer, .kix-page') && block.querySelector(`${semanticSelector}, ${customSelector}`)) return false;
      return true;
    });
    const editable = root.matches?.('[contenteditable="true"]')
      ? root
      : root.querySelector?.('[contenteditable="true"]');
    const generic = [...root.querySelectorAll('div, section')].filter(node => {
      if (node.closest(noiseSelector) || node.closest('pre') || !window.SonoraPassages.visibleBlock(node)) return false;
      if (window.SonoraPassages.isCodeChrome(node, root)) return false;
      const value = readableText(node);
      const directText = cleanText([...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.nodeValue).join(' '));
      return value.length > 1 && directText.length > 1 && !node.querySelector(semanticSelector);
    });
    const leafGeneric = generic.filter(node => !generic.some(parent => parent !== node && parent.contains(node)));
    const uncoveredGeneric = leafGeneric.filter(node => !blocks.some(block => block.contains(node) || node.contains(block)));
    const accessibleLeaves = [...root.querySelectorAll(accessibleTextSelector)].filter(node => {
      if (node.closest(noiseSelector) || !window.SonoraPassages.visibleBlock(node)) return false;
      const value = readableText(node);
      if (value.length <= 1 || node.querySelector(accessibleTextSelector)) return false;
      return true;
    });
    const pageOnlyGoogleBlocks = blocks.length > 0 && blocks.every(block => block.matches('.kix-page, .kix-lineview-content'));
    if (pageOnlyGoogleBlocks && accessibleLeaves.length) return accessibleLeaves;
    if (blocks.length || uncoveredGeneric.length) return [...blocks, ...uncoveredGeneric].sort((a, b) => a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    if (accessibleLeaves.length) return accessibleLeaves;
    if (editable && readableText(editable).length > 1 && !editable.closest(noiseSelector)) return [editable];
    if (root.matches?.('.kix-appview-editor, #kix-appview-editor, [class*="kix-appview-editor"], #docs-editor, .docs-editor, [aria-label*="Document content" i], [role="textbox"]') && readableText(root).length > 1) return [root];
    const rootDirectText = cleanText([...root.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.nodeValue).join(' '));
    if (rootDirectText.length > 1 && readableText(root).length > 1 && !root.matches?.(noiseSelector)) return [root];
    return leafGeneric;
  }

  function findReadableSource() {
    const noiseSelector = [
      'script', 'style', 'noscript', 'template', 'nav', 'header', 'footer', 'aside', 'form',
      '[role="navigation"]', '[role="banner"]', '[role="toolbar"]', '[role="menu"]', '[role="menubar"]', '[role="tablist"]', '[role="button"]',
      '[role="tooltip"]', '[hidden]', '[inert]', '.sr-only', '.visually-hidden',
      '[aria-label*="navigation" i]', '[aria-label*="toolbar" i]', '[aria-label*="menu" i]',
      '.infobox', '.navbox', '.metadata', '.mw-references-wrap', '.reflist', '.references', '.reference',
      '.mw-editsection', '.toc', '.hatnote', '.thumb', '.gallery', '.portal', '.catlinks', '.printfooter',
      '.authority-control', '.sistersitebox', '.vertical-navbox', '.docs-toolbar', '.docs-menubar',
      '.docs-titlebar', '.docs-sidebars', '.docs-ui-unprintable', '#docs-header', '#docs-menubar', '#docs-toolbar'
    ].join(',');
    if (isGoogleDocsPage()) {
      const root = document.body || document.documentElement;
      const blocks = selectReadableBlocks(root, noiseSelector);
      const text = window.SonoraDocs.passages(googleDocsSurface(root), cleanText).map(entry => entry.text).join('\n\n');
      const title = cleanText(document.title || '').replace(/\s+-\s+Google Docs$/i, '');
      return {
        text,
        title,
        root,
        blocks,
        noiseSelector,
        truncated: text.length > MAX_PAGE_CHARS
      };
    }
    if (/^(chatgpt\.com|chat\.openai\.com)$/i.test(location.hostname)) {
      const root = document.querySelector('[role="region"][aria-label="Conversation"]') || document.querySelector('main') || document.body;
      const blocks = selectReadableBlocks(root, noiseSelector);
      const text = blocks.map(readableText).filter(Boolean).join('\n\n');
      return { root, blocks, text, noiseSelector, title: cleanText(document.title || 'ChatGPT'), truncated: text.length > MAX_PAGE_CHARS };
    }
    const selectors = [
      '#mw-content-text .mw-parser-output', '#mw-content-text',
      '.kix-appview-editor', '#kix-appview-editor', '[class*="kix-appview-editor"]', '#docs-editor', '.docs-editor',
      '[aria-label*="Document content" i]', '[role="textbox"]', '[contenteditable="true"]', 'article', 'main', '[role="main"]',
      '.post-content', '.article-content', '.entry-content', '.markdown-body', 'body'
    ];
    const candidates = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(node => {
        if (candidates.some(candidate => candidate.node === node)) return;
        const clone = node.cloneNode(true);
        clone.querySelectorAll(noiseSelector).forEach(noise => noise.remove());
        const blocks = selectReadableBlocks(node, noiseSelector);
        const value = blocks.map(readableText).filter(Boolean).join('\n\n') || readableText(clone);
        const meaningful = /^(?:main|article|\.post-content|\.article-content|\.entry-content|\.markdown-body|\[role="main"\])$/.test(selector);
        if (value.length <= 80 && !meaningful) return;
        const priority = selector.startsWith('#mw-content-text') ? 10000
          : selector.includes('kix-') || selector.includes('docs-') ? 9000
            : meaningful ? 5000 : 0;
        const score = value.length + blocks.length * 180 + priority;
        candidates.push({ node, value, blocks, score });
      });
      if (candidates.some(candidate => candidate.node.matches(selector) && candidate.value.length > 200)) break;
    }
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    const fallbackRoot = document.body || document.documentElement;
    const fallbackBlocks = best?.blocks || selectReadableBlocks(fallbackRoot, noiseSelector);
    const value = (best?.value || fallbackBlocks.map(readableText).filter(Boolean).join('\n\n') || readableText(fallbackRoot)).trim();
    const titleNode = best?.node.querySelector('h1') || document.querySelector('h1');
    const title = cleanText(titleNode?.innerText || document.title || '').replace(/\s+-\s+(Wikipedia|Wiktionary)$/i, '');
    return {
      text: value,
      title,
      root: best?.node || fallbackRoot,
      blocks: fallbackBlocks,
      noiseSelector,
      truncated: value.length > MAX_PAGE_CHARS
    };
  }
})();
