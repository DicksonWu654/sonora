(() => {
  const OVERLAY_VERSION = '0.4.17';
  if (window.__sonoraOverlay) {
    if (window.__sonoraOverlay.version === OVERLAY_VERSION) {
      window.__sonoraOverlay.toggle();
      return;
    }
    try { window.__sonoraOverlay.dispose?.(); } catch { /* Replace stale overlays even if their old context was invalidated. */ }
    document.querySelector('#sonora-overlay-root')?.remove();
    delete window.__sonoraOverlay;
  }

  // Start the local voice before any synchronous page discovery.
  const pdfSource = window.__sonoraPdfUrl;
  delete window.__sonoraPdfUrl;
  let frameChoice = window.__sonoraFrameChoice || null;
  delete window.__sonoraFrameChoice;
  let frameNotice = window.__sonoraFrameNotice || (pdfSource ? 'PDF text is available in Sonora’s reader. Save this PDF, then choose it with Import file.' : '');
  delete window.__sonoraFrameNotice;
  let initialStatus = message({ type: 'sonora-status' });
  initialStatus.catch(() => {});
  let documentPort = null;
  let ownsPlayback = false;
  try { documentPort = chrome.runtime.connect?.({ name: 'sonora-reader' }); } catch { /* Older injected contexts may be invalidated by a reload. */ }
  let pageType = pageTypeFor(location.href);
  const CHATGPT_CONTAINMENT = 'coarse';
  const { cleanText, chunksFor } = window.BookText;
  const { contains: containsNode, parentOf, compare: compareNodes } = window.SonoraPassages;
  const speech = window.SonoraSpeech;
  const speed = window.SonoraSpeed;
  const MAX_PAGE_CHARS = 240000;
  const PAGE_CLASS = 'sonora-readable-block';
  const CURRENT_CLASS = 'sonora-current-block';
  let docsSurface = null;
  let docsEntries = [];
  let docsDocumentChanged = false;
  let reconcileEntries = window.SonoraPassages.createReconciler();
  let pageEntries = [];
  const entriesByKey = new Map();
  const entriesByNode = new WeakMap();
  const entriesByScope = new Map();
  let orderedEntriesDirty = false;
  let characterCount = 0;
  let entryCount = 0;
  let codeEntryCount = 0;
  let domRevision = 0;
  const extractionCache = new WeakMap();
  const dirtyTextNodes = new WeakSet();
  const insertedRoots = new WeakMap();
  let insertionEpoch = 0;
  function isTextDirty(node) {
    if (dirtyTextNodes.has(node)) return true;
    const epoch = extractionCache.get(node)?.epoch || 0;
    for (let parent = node; parent; parent = parent.parentElement) {
      if ((insertedRoots.get(parent) || 0) > epoch) return true;
      if (parent === source.root) break;
    }
    return false;
  }
  const textVersions = new WeakMap();
  const source = findReadableSource();
  const visibilityStyle = isChatGPTPage() && CHATGPT_CONTAINMENT !== 'none' ? document.createElement('style') : null;
  const skippedTurns = new WeakSet();
  if (visibilityStyle) {
    visibilityStyle.id = 'sonora-chatgpt-visibility';
  }
  function scrollportsFor(node) {
    const ports = [];
    const scrollingElement = document.scrollingElement;
    for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
      if (parent === scrollingElement || parent === document.body) continue;
      if (/auto|scroll|overlay/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) ports.push(parent);
    }
    if (scrollingElement?.scrollHeight > scrollingElement?.clientHeight) ports.push(scrollingElement);
    return ports;
  }
  function relevantScroll(event) {
    const target = event?.target;
    return !target || target === document || target === window || containsNode(source.root, target) || target.contains?.(source.root);
  }
  let containmentFrame = null, containedNode = null, containmentScan = null, containmentToken = 0;
  let finishContainment;
  const whenContained = new Promise(resolve => { finishContainment = resolve; });
  function unsafeContainmentNode(node) {
    return node.localName.includes('-') || Boolean(node.shadowRoot) || /^(fixed|sticky)$/.test(getComputedStyle(node).position);
  }
  function cancelContainmentScan() {
    if (containmentScan?.timer != null) clearTimeout(containmentScan.timer);
    containmentScan = null;
  }
  function safeContainmentChanges(roots) {
    const started = performance.now();
    let visited = 0;
    for (const root of roots) {
      if (!root.isConnected) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = root; node; node = walker.nextNode()) {
        if (++visited > 256 || (visited > 16 && performance.now() - started > 3) || unsafeContainmentNode(node)) return false;
      }
    }
    return true;
  }
  function checkContainmentChanges(records) {
    const target = containedNode || containmentScan?.target;
    if (!target) return;
    if (!target.isConnected) { setTurnContainment(false); return; }
    const roots = new Set();
    for (const record of records) {
      const changed = record.type === 'attributes' ? [record.target] : record.addedNodes || [];
      for (const node of changed) if (node.nodeType === Node.ELEMENT_NODE && (target.contains(node) || (record.type === 'attributes' && node.contains(target)))) {
        roots.add(node);
        if (roots.size > 64) { setTurnContainment(false); return; }
      }
    }
    if (containmentScan) {
      roots.forEach(node => containmentScan.dirty.add(node));
      if (containmentScan.dirty.size > 64) setTurnContainment(false);
    } else if (!safeContainmentChanges(roots)) setTurnContainment(false);
  }
  function findContainmentTarget() {
    cancelContainmentScan();
    const turns = source.root?.querySelectorAll('[data-testid^="conversation-turn-"]');
    let target = turns?.[0]?.parentElement;
    while (target && !target.contains(turns[turns.length - 1])) target = target.parentElement;
    if (!target || !containsNode(source.root, target)) { setTurnContainment(false); return; }
    // Prove the existing boundary safe without blocking opening or scrolling.
    // Include turn contents: a fixed menu inside a turn also needs its viewport.
    const scan = containmentScan = { target, node: target, walker: document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT), dirty: new Set(), timer: null };
    function batch() {
      scan.timer = null;
      if (containmentScan !== scan) return;
      if (state.closed || !target.isConnected || !target.contains(scan.node)) { setTurnContainment(false); return; }
      if (performance.now() - lastPositionChange < 150) { scan.timer = setTimeout(batch, 150); return; }
      const started = performance.now();
      do {
        if (unsafeContainmentNode(scan.node)) { setTurnContainment(false); return; }
        scan.node = scan.walker.nextNode();
      } while (scan.node && performance.now() - started < 3);
      if (scan.node) { scan.timer = setTimeout(batch, 16); return; }
      containmentScan = null;
      if (!safeContainmentChanges(scan.dirty)) { setTurnContainment(false); return; }
      setTurnContainment(true, false, target);
    }
    scan.timer = setTimeout(batch, 0);
  }
  function setTurnContainment(enabled, remove = false, target = null) {
    if (!visibilityStyle) { finishContainment(false); return; }
    if (CHATGPT_CONTAINMENT === 'coarse' && enabled && !remove && !target) { findContainmentTarget(); return; }
    if (!enabled || remove) cancelContainmentScan();
    if (CHATGPT_CONTAINMENT === 'coarse' && !enabled && !containedNode) {
      visibilityStyle.disabled = true;
      if (remove) visibilityStyle.remove();
      finishContainment(false);
      return;
    }
    if (containmentFrame !== null) cancelAnimationFrame(containmentFrame);
    // A single viewport anchor preserves position when estimated off-screen
    // heights replace actual heights (and when the stylesheet is removed).
    let anchor = null;
    for (const fraction of [.5, .25, .75]) {
      anchor = document.elementFromPoint(innerWidth / 2, innerHeight * fraction)?.closest('[data-testid^="conversation-turn-"]');
      if (anchor) break;
    }
    const top = anchor?.getBoundingClientRect().top;
    const scrollport = scrollportsFor(anchor)[0];
    if (CHATGPT_CONTAINMENT === 'coarse') {
      containedNode?.removeAttribute('data-sonora-containment');
      containedNode = enabled && !remove ? target : null;
      if (containedNode) {
        const token = ++containmentToken;
        containedNode.setAttribute('data-sonora-containment', token);
        visibilityStyle.textContent = `[data-sonora-containment="${token}"] { content-visibility: auto; contain-intrinsic-size: auto ${containedNode.scrollHeight}px; }`;
      }
    }
    if (remove) visibilityStyle.remove();
    else {
      visibilityStyle.disabled = !enabled;
      if (!visibilityStyle.isConnected) {
        if (CHATGPT_CONTAINMENT !== 'coarse') {
          // Intrinsic sizes describe the content box, excluding padding/borders.
          const firstTurn = source.root?.querySelector('[data-testid^="conversation-turn-"]');
          const container = firstTurn?.parentElement;
          const average = container ? container.scrollHeight / Math.max(1, container.childElementCount) : 600;
          const style = firstTurn && getComputedStyle(firstTurn);
          const inset = style ? ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
            .reduce((sum, property) => sum + parseFloat(style[property]), 0) : 0;
          const estimate = Math.round(Math.min(1200, Math.max(32, average - inset)));
          visibilityStyle.textContent = `[data-testid^="conversation-turn-"] { content-visibility: auto; contain-intrinsic-size: auto ${estimate}px; }`;
        }
        (document.head || document.documentElement).append(visibilityStyle);
      }
    }
    const restore = () => {
      containmentFrame = null;
      if (!anchor?.isConnected) return;
      const delta = anchor.getBoundingClientRect().top - top;
      if (scrollport && Math.abs(delta) > 1) scrollport.scrollTop += delta;
    };
    restore();
    containmentFrame = requestAnimationFrame(restore);
    finishContainment(enabled && !remove);
  }
  const visibilityListener = event => {
    if (event.skipped) {
      skippedTurns.add(event.target);
      if (event.target.contains(currentEntry()?.node)) {
        wordTracker.suspend();
        markCodePart(null, null, 'sonora-current-code');
      }
    } else skippedTurns.delete(event.target);
  };
  if (visibilityStyle) document.addEventListener('contentvisibilityautostatechange', visibilityListener, true);
  let pageText = '';
  let blockEntries = [];
  const root = document.createElement('div');
  root.id = 'sonora-overlay-root';
  const shadow = root.attachShadow({ mode: 'closed' });
  const panelMarkup = `
    <style>
      :host { all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; contain: style; overflow: visible; pointer-events: none; }
      * { box-sizing: border-box; }
      .panel, button, select { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .panel { position: fixed; z-index: 2147483647; top: 16px; right: 16px; width: min(390px, calc(100vw - 32px)); max-height: calc(100vh - 32px); display: flex; flex-direction: column; overflow: hidden; pointer-events: auto; color: #eff2ec; background: #121815; border: 1px solid #354239; border-radius: 12px; box-shadow: 0 18px 70px #000b, 0 2px 12px #0008; }
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
      select, input[type="range"] { width: 100%; min-height: 34px; }
      select { padding: 0 8px; border: 1px solid #354239; border-radius: 5px; outline: 0; background: #202b23; color: #dce1d9; font-size: 11px; text-transform: none; letter-spacing: 0; }
      input[type="range"] { accent-color: #d8b28b; }
      .speed-caption { display: flex; justify-content: space-between; }
      output { color: #d8b28b; letter-spacing: 0; }
      select:focus-visible, input:focus-visible, button:focus-visible { outline: 2px solid #d8b28b; outline-offset: 2px; }
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
      .track i { display: block; width: 100%; height: 100%; background: #d8b28b; transform: scaleX(0); transform-origin: left; transition: transform .15s; }
      .hint { margin: 9px 0 0; color: #718076; font: 9px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .pdf-reader, .frame-switch { margin: 12px 18px; padding: 10px; border: 0; border-radius: 5px; background: #d8b28b; color: #292018; cursor: pointer; }
      @keyframes sonar-blink { 50% { opacity: .35; } }
      @media (prefers-reduced-motion: reduce) { .dot.busy { animation: none; } }
    </style>
    <aside class="panel" aria-label="Sonora page reader">
      <header class="top"><span class="mark" aria-hidden="true">◒</span><span class="brand">sonora</span><span class="local"><i></i> local voice</span><button class="icon minimize" type="button" aria-label="Minimize Sonora">−</button><button class="icon close" type="button" aria-label="Close Sonora">×</button></header>
      <section class="heading"><p class="eyebrow">CLICK PAGE TEXT TO READ</p><h2></h2><p class="meta"></p></section>
      <div class="status"><i class="dot"></i><span></span></div>
      <section class="controls" aria-label="Voice controls"><label>Voice<select class="voice" aria-label="Voice"><option value="af_heart">Heart · warm</option><option value="af_bella">Bella · clear</option></select></label><label><span class="speed-caption">Speed <output class="speed-value" for="sonora-speed">1×</output></span><input id="sonora-speed" class="speed" aria-label="Speed" type="range" min="1" max="3" step="0.1" value="1"></label></section>
      <section class="selection" aria-label="Reading instructions"><p class="selection-title">Page reader ready</p><p class="selection-copy">Click any text block, table cell, or heading on the page to start there. Keep scrolling and choose another block whenever you want.</p></section>
      <button class="pdf-reader" type="button" hidden>Open PDF in reader</button>
      <button class="frame-switch" type="button" hidden>Read embedded document</button>
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
    voice: shadow.querySelector('.voice'), speed: shadow.querySelector('.speed'), speedValue: shadow.querySelector('.speed-value'), play: shadow.querySelector('.play'), playIcon: shadow.querySelector('.play-icon'), playLabel: shadow.querySelector('.play-label'), stop: shadow.querySelector('.stop'), track: shadow.querySelector('.track i'), audio: shadow.querySelector('audio'), minimize: shadow.querySelector('.minimize'), close: shadow.querySelector('.close')
  };
  const state = {
    index: -1,
    queue: [],
    queueIterator: null,
    queueOffset: 0,
    queueBlocks: null,
    queueStart: null,
    queueWaiting: false,
    queueEnded: false,
    rendered: new Map(),
    renderRequests: new Map(),
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
  let savedPositions = [], resumeRecord = null, resumeEntry = null, mediaBound = false;
  const frameSwitch = shadow.querySelector('.frame-switch');
  function setFrameChoice(choice) {
    frameChoice = choice;
    frameSwitch.hidden = !choice?.embedded && !choice?.back;
    frameSwitch.textContent = choice?.back ? 'Read top page' : 'Read embedded document';
  }
  setFrameChoice(frameChoice);
  frameSwitch.addEventListener('click', () => {
    frameSwitch.disabled = true;
    message({type: 'sonora-switch-document', document: frameChoice?.back ? 'top' : 'embedded'})
      .catch(error => setStatus(error.message, 'error')).finally(() => { frameSwitch.disabled = false; });
  });
  if (pdfSource) {
    const button = shadow.querySelector('.pdf-reader'); button.hidden = false;
    shadow.querySelector('.selection-title').textContent = 'Read this PDF in Sonora';
    shadow.querySelector('.selection-copy').textContent = 'Save this PDF, open the reader, and choose the saved file with Import file.';
    button.addEventListener('click', () => message({ type: 'sonora-open-pdf-reader' }).catch(error => setStatus(error.message, 'error')));
  }
  let refreshTimer = null, refreshIdle = null;
  const dirtyScopes = new Map();
  const scopeRefreshes = new Map();
  let scopeRefreshHandle = null;
  let fullRefreshPending = false;
  let sourceUrl = location.href;
  const navigationTimer = setInterval(() => {
    if (sourceUrl !== location.href) scheduleBlockRefresh();
  }, 1000);
  const knownBlocks = new Set();
  const wordTracker = window.SonoraWords.createTracker(document, shadow);
  const codeRange = window.SonoraWords.createRangeResolver(document);
  let wordFrame = null, geometryFrame = null;
  let activeHighlightEntry = null, activeHighlightTurn = null;
  const changedSettings = new Set();
  const pageClass = PAGE_CLASS;
  const currentClass = CURRENT_CLASS;
  let docsHover = null;
  let codeHoverPoint = null;
  let codeHoverFrame = null;
  let codeHoverTimer = null, codeScrollTimer = null, codeScrolling = false;
  let lastPositionChange = -Infinity, positionFrame = null;
  let followReading = true, autoScrollUntil = -Infinity;
  let clickRevision = 0;
  const priorityReaders = new Map();
  els.audio.preservesPitch = true;
  applySpeed(els.speed.value);

  els.title.textContent = source.title || document.title || 'Untitled page';
  els.meta.textContent = `${blockEntries.length} clickable ${blockEntries.length === 1 ? 'block' : 'blocks'} · ${pageText.length.toLocaleString()} characters${source.truncated ? ' · first 240,000 shown' : ''}`;

  let panelWriteFrame = null;
  let pendingPanel = {}, panelDirty = false;
  function schedulePanelWrite() {
    if (!panelDirty || panelWriteFrame !== null || wordFrame !== null || state.closed) return;
    panelWriteFrame = requestAnimationFrame(flushPanelWrites);
  }
  function flushPanelWrites() {
    if (panelWriteFrame !== null) cancelAnimationFrame(panelWriteFrame);
    panelWriteFrame = null;
    if (state.closed || !panelDirty) return;
    panelDirty = false;
    const pending = pendingPanel;
    pendingPanel = {};
    if (pending.status) {
      const [message, mode] = pending.status;
      if (els.status.textContent !== message) els.status.textContent = message;
      const className = `dot ${mode}`;
      if (els.dot.className !== className) els.dot.className = className;
    }
    if (pending.transport) {
      const [playing, label] = pending.transport;
      const icon = playing ? 'Ⅱ' : '▶';
      if (els.playIcon.textContent !== icon) els.playIcon.textContent = icon;
      if (els.playLabel.textContent !== label) els.playLabel.textContent = label;
      els.play.classList.toggle('is-playing', playing);
    }
    if (pending.progress !== undefined) {
      const transform = `scaleX(${pending.progress})`;
      if (els.track.style.transform !== transform) els.track.style.transform = transform;
    }
  }
  function setPanelProgress(value) {
    pendingPanel.progress = value;
    panelDirty = true;
    schedulePanelWrite();
  }
  function setStatus(message, mode = '') {
    state.status = message;
    pendingPanel.status = [message, mode];
    panelDirty = true;
    schedulePanelWrite();
  }
  function readyMessage() {
    if (frameNotice) return frameNotice;
    if (resumeEntry && !state.queue.length) return 'Previous reading position found — press Resume to continue.';
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
  function applySpeed(value, persist = false) {
    const rate = speed.normalizeSpeed(value);
    els.speed.value = String(rate);
    els.speedValue.textContent = speed.formatSpeed(rate);
    els.audio.playbackRate = rate;
    if (persist) saveSetting('sonoraSpeed', rate);
    return rate;
  }
  function loadSettings() {
    try {
      const storage = chrome.storage?.local;
      if (!storage?.get) return;
      Promise.resolve(storage.get(['sonoraSpeed', 'sonoraVoice', 'sonoraPositions'])).then(saved => {
        if (state.closed) return;
        if (!changedSettings.has('sonoraSpeed') && saved?.sonoraSpeed !== undefined) {
          const migrated = applySpeed(saved.sonoraSpeed);
          if (migrated !== Number(saved.sonoraSpeed)) saveSetting('sonoraSpeed', migrated);
        }
        if (!changedSettings.has('sonoraVoice') && saved?.sonoraVoice && [...els.voice.options].some(option => option.value === saved.sonoraVoice)) els.voice.value = saved.sonoraVoice;
        savedPositions = (Array.isArray(saved?.sonoraPositions) ? saved.sonoraPositions : []).filter(validPosition).slice(0, 20);
        if (!state.queue.length) {
          resumeRecord = savedPositions.find(record => record.document === window.SonoraPassages.pageIdentity(location.href)) || null;
          if (resumeRecord) for (const entry of entriesByKey.values()) offerResume(entry);
        }
      }).catch(() => {});
    } catch { /* Storage can be unavailable in restricted test pages. */ }
  }
  function validPosition(record) {
    return record && typeof record.document === 'string' && record.document.length <= 4096
      && typeof record.prefix === 'string' && record.prefix.length <= 160 && typeof record.text === 'string' && record.text.length > 0 && record.text.length <= 1200
      && Number.isInteger(record.offset) && record.offset >= 0 && Number.isInteger(record.blockIndex) && record.blockIndex >= 0;
  }
  function savePosition() {
    const item = state.queue[state.index], entry = currentEntry();
    if (!item || !entry || state.completed) return;
    const record = { document: window.SonoraPassages.pageIdentity(location.href), prefix: entry.text.slice(0, 160), text: item.text,
      offset: item.blockOffset, blockIndex: entry.index, scope: entry.scope, updatedAt: Date.now() };
    if (!validPosition(record)) return;
    savedPositions = [record, ...savedPositions.filter(previous => previous.document !== record.document)].slice(0, 20);
    if (documentPort) message({ type: 'sonora-save-position', record }).catch(() => {});
    else saveSetting('sonoraPositions', savedPositions);
  }
  function matchesResume(entry) {
    return resumeRecord && entry?.node.isConnected && resumeRecord.document === window.SonoraPassages.pageIdentity(location.href)
      && entry.text.startsWith(resumeRecord.prefix)
      && entry.text.slice(resumeRecord.offset, resumeRecord.offset + resumeRecord.text.length) === resumeRecord.text
      && (!/^(turn:|message:|block:)/.test(resumeRecord.scope || '') || resumeRecord.scope === entry.scope);
  }
  function offerResume(entry) {
    if (!isGoogleDocsPage() && !indexingDone && !/^(turn:|message:|block:)/.test(resumeRecord?.scope || '')) return;
    if (state.queue.length || !matchesResume(entry)) return;
    if (!resumeEntry || Math.abs(entry.index - resumeRecord.blockIndex) < Math.abs(resumeEntry.index - resumeRecord.blockIndex)) {
      resumeEntry = entry; updateTransport();
    }
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
  const markedNodes = new Set();
  const codeMarks = new Map();
  function clearCurrentBlock() {
    markedNodes.forEach(node => node.classList.remove(currentClass));
    markedNodes.clear();
    window.CSS?.highlights?.delete('sonora-current-code');
    codeMarks.get('sonora-current-code')?.forEach(node => node.remove()); codeMarks.delete('sonora-current-code');
  }
  function markCodePart(entry, part, name) {
    const previous = codeMarks.get(name) || [];
    previous.forEach(node => node.remove()); codeMarks.delete(name);
    const range = part && codeRange(entry, part.offset, part.text.length);
    if (!range) {
      if (part && codeRange.pending && name === 'sonora-hover-code') scheduleCodeHover(true);
      return;
    }
    // A highlight style inherited through a 20,000-line syntax tree forces
    // Chromium to restyle every span. Small range rectangles avoid that cost.
    const boxes = [];
    const clip = window.SonoraWords.clipFor(entry, document);
    for (const bounds of range.getClientRects()) {
      const rect = { left: Math.max(clip.left, bounds.left), top: Math.max(clip.top, bounds.top),
        right: Math.min(clip.right, bounds.right), bottom: Math.min(clip.bottom, bounds.bottom) };
      rect.width = rect.right - rect.left; rect.height = rect.bottom - rect.top;
      if (rect.height <= 0 || rect.width <= 0) continue;
      const box = document.createElement('div'); box.className = 'word-mark';
      Object.assign(box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
        background: name === 'sonora-current-code' ? 'rgba(216,178,139,.32)' : 'rgba(216,178,139,.18)' });
      shadow.append(box); boxes.push(box);
    }
    codeMarks.set(name, boxes);
  }
  function codePartAt(entry, x, y) {
    const bounds = window.SonoraWords.clipFor(entry, document);
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    const offset = codeRange.offsetAt(entry, x, y);
    if (offset === null) {
      if (codeRange.offsetPending) scheduleCodeHover(true);
      return null;
    }
    return codePartForOffset(entry, offset);
  }
  function codePartForOffset(entry, offset) {
    const line = Math.max(0, entry.text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1);
    let from = line;
    if (offset - line > 1200) {
      from = Math.max(line, offset - 600);
      const boundary = entry.text.slice(from, offset).search(/\s+\S*$/u);
      if (boundary >= 0) from += boundary + 1;
      if (/[\udc00-\udfff]/.test(entry.text[from])) from--;
    }
    const parts = window.SonoraPassages.codePassages(entry.text.slice(from, from + 2400), chunksFor);
    const part = parts.findLast(part => part.offset <= offset - from) || parts[0];
    return part ? { text: part.text, offset: from + part.offset } : null;
  }

  function updateCodeHover() {
    if (!codeEntryCount) return;
    const current = currentEntry(), item = state.queue[state.index];
    if (codeScrolling) {
      markCodePart(null, null, 'sonora-current-code');
      markCodePart(null, null, 'sonora-hover-code');
      return;
    }
    if (current?.kind === 'code' && !skippedTurns.has(current.node.closest('[data-testid^="conversation-turn-"]')) && item && !codeMarks.has('sonora-current-code')) markCodePart(current, { text: item.text, offset: item.blockOffset }, 'sonora-current-code');
    const point = codeHoverPoint;
    const block = point && (point.block === undefined ? document.elementFromPoint(point.x, point.y)?.closest('pre') : point.block);
    const entry = block && entriesByNode.get(block);
    markCodePart(entry, entry && codePartAt(entry, point.x, point.y), 'sonora-hover-code');
  }
  function scheduleCodeHover(immediate = false) {
    if (!codeEntryCount) return;
    const schedule = () => {
      codeHoverTimer = null;
      if (codeHoverFrame !== null || state.closed) return;
      codeHoverFrame = requestAnimationFrame(() => { codeHoverFrame = null; updateCodeHover(); });
    };
    if (immediate) schedule();
    else {
      if (codeHoverTimer !== null) clearTimeout(codeHoverTimer);
      codeHoverTimer = setTimeout(schedule, 80);
    }
  }
  function currentEntry() {
    const item = state.queue[state.index];
    return item && (item.blockKey ? entriesByKey.get(item.blockKey) : blockEntries[item.blockIndex]);
  }
  function invalidateGeometry(records) {
    if (!activeHighlightEntry || state.index < 0 || state.completed) return;
    const affected = records.some(record => {
      const target = record.target?.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target;
      return target && containsNode(source.root, target) && (target.contains(activeHighlightEntry.node) || activeHighlightTurn?.contains(target));
    });
    if (!affected) return;
    wordTracker.invalidate();
    if (codeScrolling || geometryFrame !== null) return;
    geometryFrame = requestAnimationFrame(() => {
      geometryFrame = null;
      if (state.closed || codeScrolling) return;
      paintCurrentWord();
      const item = state.queue[state.index];
      if (activeHighlightEntry?.kind === 'code' && item) markCodePart(activeHighlightEntry, {text: item.text, offset: item.blockOffset}, 'sonora-current-code');
    });
  }
  function paintCurrentWord() {
    if (codeScrolling || skippedTurns.has(activeHighlightTurn)) return;
    const position = state.webAudioBuffer ? webAudioPosition() : els.audio.currentTime;
    wordTracker.update(activeHighlightEntry, position, isGoogleDocsPage() ? googleDocsSurface(source.root) : null);
  }
  function stopWordFrames() {
    if (wordFrame !== null) cancelAnimationFrame(wordFrame);
    wordFrame = null;
    if (panelDirty) schedulePanelWrite();
  }
  function startWordFrames() {
    stopWordFrames();
    if (codeScrolling) return;
    if (panelWriteFrame !== null) cancelAnimationFrame(panelWriteFrame);
    panelWriteFrame = null;
    const tick = () => {
      wordFrame = null;
      if (state.closed) return;
      flushPanelWrites();
      if (!state.playing) return;
      paintCurrentWord();
      wordFrame = requestAnimationFrame(tick);
    };
    wordFrame = requestAnimationFrame(tick);
  }
  function resetWords() { stopWordFrames(); wordTracker.reset(); }
  function revealPassage(entry, item) {
    if (!isChatGPTPage() || !entry?.node.isConnected || !followReading) return;
    const turn = entry.node.closest('[data-testid^="conversation-turn-"]');
    if (!turn) return;
    autoScrollUntil = performance.now() + 300;
    if (skippedTurns.has(turn)) entry.node.scrollIntoView({ block: 'center', behavior: 'instant' });
    const range = codeRange(entry, item.blockOffset, 1);
    if (!range) return;
    let rect = range.getClientRects()[0];
    if (!rect) return;
    for (const port of scrollportsFor(range.startContainer)) {
      const viewport = port === document.scrollingElement;
      const bounds = viewport ? { top: 0, bottom: innerHeight } : port.getBoundingClientRect();
      const top = Math.max(60, bounds.top + (viewport ? 0 : port.clientTop));
      const bottom = Math.min(innerHeight - 80, viewport ? bounds.bottom : bounds.top + port.clientTop + port.clientHeight);
      if (rect && (rect.top < top || rect.bottom > bottom)) {
        port.scrollTop += rect.top - top - (bottom - top) / 3;
        rect = range.getClientRects()[0];
      }
    }
  }
  function markCurrentBlock(blockIndex, blockKey) {
    clearCurrentBlock();
    const entry = blockKey ? entriesByKey.get(blockKey) : blockEntries[blockIndex];
    activeHighlightEntry = entry;
    activeHighlightTurn = entry?.node.closest('[data-testid^="conversation-turn-"]');
    if (entry && !(isChatGPTPage() && entry.kind === 'code')) (entry.nodes || [entry.node]).forEach(node => { node.classList.add(currentClass); markedNodes.add(node); });
    const item = state.queue[state.index];
    if (entry?.kind === 'code' && item && !codeScrolling && !skippedTurns.has(entry.node.closest('[data-testid^="conversation-turn-"]'))) markCodePart(entry, { text: item.text, offset: item.blockOffset }, 'sonora-current-code');
  }
  function updateTransport() {
    const label = state.playing || state.pendingRender || state.pendingStart !== null || state.queueWaiting ? 'Pause' : (state.index >= 0 && !state.completed || resumeEntry && !state.queue.length ? 'Resume' : 'Play from top');
    pendingPanel.transport = [state.playing, label];
    panelDirty = true;
    schedulePanelWrite();
    updateMediaSession();
  }
  function updateMediaSession() {
    const media = navigator.mediaSession;
    if (!media) return;
    try {
      const active = !state.closed && (!documentPort || ownsPlayback) && state.index >= 0 && !state.completed;
      if (active && !mediaBound) {
        const handlers = { play: () => { if (!state.playing) els.play.click(); }, pause: () => { state.pendingStart = null; pausePlayback(); setStatus('Paused', 'ready'); },
          stop, nexttrack: () => advanceQueue(), previoustrack: () => play(Math.max(0, state.index - 1)) };
        for (const [name, handler] of Object.entries(handlers)) try { media.setActionHandler(name, handler); } catch {}
        mediaBound = true;
      } else if (!active && mediaBound) {
        for (const name of ['play','pause','stop','nexttrack','previoustrack']) try { media.setActionHandler(name, null); } catch {}
        mediaBound = false;
      }
      media.playbackState = active ? (state.playing ? 'playing' : 'paused') : 'none';
      if (active && typeof MediaMetadata !== 'undefined' && media.metadata?.title !== source.title) media.metadata = new MediaMetadata({ title: source.title || 'Sonora reading', artist: 'Sonora' });
      if (!active) media.metadata = null;
    } catch { /* Media controls are optional in embedded/restricted documents. */ }
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
      // Chromium permits playback after the page's sticky user activation.
      // The first text click supplies it before synthesis completes.
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
    if (codeScrolling) return;
    const duration = state.webAudioBuffer?.duration || 0;
    const part = duration ? position / duration : 0;
    setPanelProgress(Math.min(1, (state.index + part) / Math.max(1, state.queue.length)));
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
  let decodedAudio = null;
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
      const decoded = decodedAudio?.source === source ? decodedAudio.buffer
        : await context.decodeAudioData(bytesFromDataSource(source).buffer);
      if (revision !== state.revision || run !== state.webAudioRun) return false;
      decodedAudio = { source, buffer: decoded };
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
    state.webAudioTimer = setInterval(() => { if (!codeScrolling) updateProgress(webAudioPosition()); }, 250);
    return true;
  }
  function pausePlayback() {
    savePosition();
    state.queueWaiting = false;
    stopWordFrames();
    pauseWebAudio();
    els.audio.pause();
    // Prefetch should not keep using the voice while the reader is paused.
    for (const index of state.renderRequests.keys()) { cancelRender(index); state.rendered.delete(index); }
    if (state.pendingRender) {
      // A render may still be waiting on the local model. Invalidate that
      // request so its eventual response cannot start playback after pause.
      state.revision++;
      state.pendingRender = false;
      cancelRendered();
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
  function queueFrom(blockIndex = 0, limit = MAX_PAGE_CHARS, blockOffset = 0, shortOpening = false) {
    ensureOrderedEntries();
    const queue = [];
    let remaining = limit;
    for (let at = blockIndex; at < blockEntries.length && remaining > 0; at++) {
      const entry = blockEntries[at];
      const blockText = entry.text.slice(0, remaining);
      let cursor = at === blockIndex ? blockOffset : 0;
      while (cursor < blockText.length) {
        let part = window.SonoraPassages.nextPart(blockText, cursor, false, chunksFor, shortOpening && !queue.length ? window.BookText.openingChunksFor : null);
        if (speech) part = speech.completePart(blockText, part);
        if (!part) break;
        queue.push({ text: part.text, blockIndex: entry.index, blockKey: entry.key, blockOffset: part.offset });
        cursor = part.offset + part.text.length;
      }
      remaining -= blockText.length;
    }
    return queue;
  }
  function* lazyQueue(entry, offset = 0) {
    // Snapshot discovered blocks, but split only the current/next passage. The
    // selected block is always first, even while background discovery runs.
    const selected = { ...entry };
    const following = [...entriesByKey.values()].filter(other => other.node !== entry.node
      && (compareNodes(entry.node, other.node) & Node.DOCUMENT_POSITION_FOLLOWING));
    following.sort((a, b) => compareNodes(a.node, b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const snapshot = state.queueBlocks = [selected, ...following.map(block => ({ ...block }))];
    yield* queuedPassages(snapshot, offset);
  }
  function* queuedPassages(snapshot, offset = 0, start = 0, opening = true) {
    for (let at = start; at < snapshot.length || !indexingDone || scopeRefreshes.size || dirtyScopes.size; at++) {
      if (at >= snapshot.length) { yield null; at--; continue; }
      const block = snapshot[at];
      // A block selected earlier may already be known far beyond the scan.
      // Wait for discovery to fill the gap before buffering that later block.
      if (at && !indexingDone && (!discoveryFrontier
        || (compareNodes(block.node, discoveryFrontier) & Node.DOCUMENT_POSITION_PRECEDING))) { yield null; at--; continue; }
      let cursor = at === start ? offset : 0, unfinishedUrl = false;
      while (cursor < block.text.length || block.partial) {
        if (cursor >= block.text.length || !opening && block.partial && block.text.length - cursor < 1201) { yield null; continue; }
        if (unfinishedUrl) {
          const boundary = block.text.slice(cursor).search(/[\s<>]/u);
          if (boundary < 0) { cursor = block.text.length; if (!block.partial) break; yield null; continue; }
          cursor += boundary; unfinishedUrl = false;
        }
        while (/\s/u.test(block.text[cursor] || '') && cursor < block.text.length) cursor++;
        if (cursor >= block.text.length) break;
        let part = window.SonoraPassages.nextPart(block.text, cursor, block.kind === 'code', chunksFor, opening ? window.BookText.openingChunksFor : null);
        if (speech) part = speech.completePart(block.text, part, block.partial);
        if (!part) break;
        opening = false;
        yield { text: part.text, blockKey: block.key, blockIndex: block.index, blockOffset: part.offset };
        cursor = part.offset + part.text.length;
        unfinishedUrl = Boolean(part.urlContinues);
      }
    }
  }
  // The backend renders one passage at a time in request order, so queueing a
  // few passages ahead keeps a long passage from starting only when the short
  // one before it ends. Abandoned requests are cancelled by trimRendered().
  const PREFETCH_AHEAD = 8;
  // Same rule as the narration worker: a passage needs a letter or digit.
  const hasReadableWords = text => /[\p{L}\p{N}]/u.test(text);
  function prefetchAhead() {
    fillQueue();
    // Short passages play for under a second, so look ahead by amount of speech
    // (about a minute) as well as by count.
    let words = 0;
    const budget = 150 * (Number(els.speed.value) || 1);
    for (let at = state.index + 1; at <= state.index + PREFETCH_AHEAD && at < state.queue.length && words < budget; at++) {
      const text = state.queue[at].text;
      if (!hasReadableWords(text)) continue;
      words += text.split(/\s+/u).length;
      render(at).catch(() => {});
    }
  }
  function fillQueue() {
    if (!state.queueIterator) return;
    while (state.queue.length < state.index + PREFETCH_AHEAD + 1) {
      const next = state.queueIterator.next();
      if (next.done) { state.queueIterator = null; break; }
      if (!next.value) break;
      state.queue.push(next.value);
    }
  }
  function passageLabel(index = state.index) {
    const number = state.queueOffset + index + 1;
    return state.queueIterator ? String(number) : `${number} of ${state.queueOffset + state.queue.length}`;
  }
  function render(index) {
    const item = state.queue[index];
    if (!item) return Promise.reject(new Error('No readable passage is selected.'));
    if (state.rendered.has(index)) return state.rendered.get(index);
    const requestId = `${state.revision}:${index}:${Math.random().toString(36).slice(2)}`;
    const prepared = speech?.prepare(item.text);
    const promise = message({ type: 'sonora-render', requestId, text: prepared?.text || item.text, voice: els.voice.value })
      .then(result => prepared ? { ...result, words: speech.mapWords(prepared, result.words) } : result);
    state.rendered.set(index, promise);
    state.renderRequests.set(index, requestId);
    promise.catch(() => { for (const [at, value] of state.rendered) if (value === promise) state.rendered.delete(at); })
      .finally(() => { for (const [at, id] of state.renderRequests) if (id === requestId) state.renderRequests.delete(at); });
    return promise;
  }
  async function claimPlayback(revision = state.revision) {
    if (!documentPort || ownsPlayback) return revision === state.revision;
    const result = await message({ type: 'sonora-claim-playback' });
    if (revision !== state.revision || result?.owned === false) return false;
    ownsPlayback = true;
    return true;
  }
  const renderReadyListener = (payload, sender, respond) => {
    if (payload?.type === 'sonora-dispose-reader' && !state.closed) {
      els.close.click();
      respond?.({ok: true});
      return false;
    }
    if (payload?.type === 'sonora-pause-playback' && !state.closed) {
      ownsPlayback = false;
      state.revision++;
      state.pendingStart = null;
      pausePlayback();
      setStatus('Paused — reading started in another tab.', 'ready');
      respond?.({ ok: true });
      return false;
    }
    if (state.closed || payload?.type !== 'sonora-render-ready') return;
    if (state.renderRequests.get(state.index) !== payload.requestId) return;
    prefetchAhead();
    // Audio service setup must not delay sending the first render request.
    if (!state.audioContext) primeAudioContext();
  };
  chrome.runtime.onMessage?.addListener(renderReadyListener);
  function cancelRender(index) {
    const requestId = state.renderRequests.get(index);
    if (!requestId) return;
    state.renderRequests.delete(index);
    message({ type: 'sonora-cancel-render', requestId }).catch(() => {});
  }
  function cancelRendered() {
    for (const index of state.renderRequests.keys()) cancelRender(index);
    state.rendered.clear();
  }
  function trimRendered(index) {
    for (const key of state.rendered.keys()) {
      if (key < index || key > index + PREFETCH_AHEAD) { cancelRender(key); state.rendered.delete(key); }
    }
  }
  async function play(index = state.index < 0 ? 0 : state.index) {
    fillQueue();
    const item = state.queue[index];
    if (!item || !state.ready) return;
    const revision = ++state.revision;
    state.index = index;
    state.queueWaiting = state.queueEnded = false;
    state.completed = false;
    state.playing = false;
    if (!hasReadableWords(item.text)) {
      // Emoji, symbols or lone citation marks have nothing to say: move on now.
      state.pendingRender = false;
      advanceQueue(revision);
      return;
    }
    state.pendingRender = true;
    resetWords();
    els.audio.pause();
    resetWebAudio();
    releaseAudioObjectUrl();
    els.audio.removeAttribute('src');
    els.audio.load();
    trimRendered(index);
    revealPassage(currentEntry(), item);
    markCurrentBlock(item.blockIndex, item.blockKey);
    updateTransport();
    if (!codeScrolling) setPanelProgress(0);
    setStatus(`Rendering passage ${passageLabel(index)}…`, 'busy');
    try {
      if (documentPort && !ownsPlayback && !await claimPlayback(revision)) return;
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
      savePosition();
      startWordFrames();
      setStatus(`Playing passage ${passageLabel(index)}`, 'ready');
      updateTransport();
      state.renderFailures = 0;
      prefetchAhead();
    } catch (error) {
      if (revision !== state.revision) return;
      if (error.name !== 'NotAllowedError' && (state.renderFailures = (state.renderFailures || 0) + 1) <= 3
        && (index + 1 < state.queue.length || state.queueIterator)) {
        // A passage the voice cannot render must not hold up the ones after it.
        state.pendingRender = false;
        advanceQueue(revision);
        return;
      }
      state.pendingRender = false;
      state.playing = false;
      updateTransport();
      setStatus(error.name === 'NotAllowedError' ? 'Audio is ready. Press play to start.' : error.message, 'error');
    }
  }
  function startQueue(blockIndex = 0, blockOffset = 0, clickedEntry = null) {
    resumeRecord = resumeEntry = null;
    followReading = true;
    const selected = state.queue[state.index];
    if (state.pendingRender && selected?.blockKey === blockEntries[blockIndex]?.key && selected.blockOffset === blockOffset) return;
    if (!clickedEntry) ensureOrderedEntries();
    const entry = clickedEntry || blockEntries[blockIndex];
    state.queueIterator = !isGoogleDocsPage() && entry ? lazyQueue(entry, blockOffset) : null;
    state.queueOffset = 0;
    state.queueWaiting = state.queueEnded = false;
    state.queueBlocks = null;
    const queue = state.queueIterator ? [] : queueFrom(blockIndex, MAX_PAGE_CHARS, blockOffset, true);
    if (state.queueIterator) { const first = state.queueIterator.next(); if (!first.done && first.value) queue.push(first.value); }
    if (!queue.length) {
      setStatus(isGoogleDocsPage() ? readyMessage() : 'No readable text was found in that block.', 'error');
      return;
    }
    state.revision++;
    state.queue = queue;
    state.queueStart = entry ? { entry: state.queueBlocks?.[0] || entry, offset: blockOffset } : null;
    state.index = 0;
    fillQueue();
    const startIndex = 0;
    cancelRendered();
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
    setPanelProgress(0);
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
    state.queueWaiting = state.queueEnded = false;
    clickRevision++;
    resetWords();
    state.revision++;
    cancelRendered();
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
    setPanelProgress(0);
    clearCurrentBlock();
    updateTransport();
    if (state.ready) setStatus(readyMessage(), blockEntries.length ? 'ready' : 'error');
  }
  async function checkVoice() {
    if (state.closed) return;
    if (state.voiceTimer) { clearTimeout(state.voiceTimer); state.voiceTimer = null; }
    try {
      const request = initialStatus || message({ type: 'sonora-status' });
      initialStatus = null;
      const data = await request;
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
        state.voiceTimer = setTimeout(() => { state.voiceTimer = null; checkVoice(); }, 200);
      } else {
        setStatus(data.message || 'Start the Sonora supervisor.', 'error');
        // Keep checking so installing or restarting the local model takes
        // effect without requiring the page reader to be reopened.
        state.voiceTimer = setTimeout(() => { state.voiceTimer = null; checkVoice(); }, 5000);
      }
    } catch {
      if (state.closed) return;
      state.ready = false;
      setStatus('Sonora is offline — start the Sonora supervisor.', 'error');
      state.voiceTimer = setTimeout(() => { state.voiceTimer = null; checkVoice(); }, 3000);
    }
  }
  function handlePageClick(event, block) {
    if (!readingGesture(event) || (event.defaultPrevented && !isGoogleDocsPage()) || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('button,input,textarea,select,summary,[role="button"]')) return;
    if (target?.closest('a,[role="link"]')) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (dirtyScopes.has(window.SonoraPassages.scopeFor(block))) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshBlocks();
    }
    const entry = entriesByNode.get(block);
    if (!entry) return;
    if (isTextDirty(block)) {
      // A click can beat the idle refresh. Read only this block's opening;
      // background discovery will finish a large block without delaying audio.
      const updated = makeIncomingEntries([block], 2400)[0];
      if (!updated) return;
      characterCount += updated.text.length - entry.text.length;
      Object.assign(entry, updated);
    }
    const token = ++clickRevision;
    if (entry.kind === 'code' && event.detail !== 0) {
      selectCodeLine(entry, event, token);
      return;
    }
    if (isGoogleDocsPage()) {
      event.preventDefault();
      event.stopPropagation();
    }
    startQueue(entry.index, 0, entry);
  }
  function selectCodeLine(entry, event, token, position = null) {
    if (state.closed || token !== clickRevision || !entry.node.isConnected) return;
    const offset = codeRange.offsetAt(entry, event.clientX, event.clientY, position);
    const caret = position || codeRange.caret;
    if (offset === null) {
      if (codeRange.offsetPending) {
        const next = () => selectCodeLine(entry, event, token, caret);
        if (globalThis.scheduler?.postTask) scheduler.postTask(next, { priority: 'user-blocking' }).catch(() => {});
        else setTimeout(next, 0);
      }
      return;
    }
    if (entry.partial && offset >= entry.text.length - 1200) {
      completeClickedEntry(entry).then(() => selectCodeLine(entry, event, token, caret))
        .catch(error => { if (!state.closed && token === clickRevision) setStatus(error.message, 'error'); });
      return;
    }
    const part = codePartForOffset(entry, offset);
    if (part) startQueue(entry.index, part.offset, entry);
  }
  function completeClickedEntry(entry) {
    if (priorityReaders.has(entry.node)) return priorityReaders.get(entry.node);
    const reader = window.SonoraPassages.createTextReader(entry.contentNode || entry.node, cleanText);
    const task = new Promise(resolve => {
      function step() {
        if (state.closed || !entry.node.isConnected) { resolve(); return; }
        const result = reader.advance(3);
        if (result.done) {
          characterCount += result.text.length - entry.text.length;
          Object.assign(entry, { text: result.text, partial: false, domRevision: ++domRevision });
          extractionCache.set(entry.node, { epoch: insertionEpoch, text: result.text, revision: entry.domRevision });
          dirtyTextNodes.delete(entry.node);
          resolve(); return;
        }
        if (globalThis.scheduler?.postTask) scheduler.postTask(step, { priority: 'user-blocking' }).catch(() => resolve());
        else setTimeout(step, 0);
      }
      step();
    }).finally(() => priorityReaders.delete(entry.node));
    priorityReaders.set(entry.node, task);
    return task;
  }
  function updateBlocks(nextBlocks, navigated = false) {
    const nextEntries = makeBlockEntries(nextBlocks);
    entriesByKey.clear();
    entriesByScope.clear();
    characterCount = entryCount = codeEntryCount = 0;
    nextEntries.forEach(indexEntry);
    const activeItem = state.queue[state.index >= 0 ? state.index : (state.pendingStart ?? 0)];
    const activeEntry = activeItem && nextEntries.find(entry => entry.key === activeItem.blockKey);
    const edited = !isGoogleDocsPage() && activeEntry && !window.SonoraPassages.matchesPassage(activeEntry, activeItem);
    const changed = isGoogleDocsPage() ? docsDocumentChanged : navigated || edited;
    if (changed && state.queue.length) {
      // Keep the selected queue through unrelated updates and DOM redraws.
      // A new page or an edit to the spoken text ends the old session.
      state.revision++;
      state.queueWaiting = state.queueEnded = false;
      state.pendingStart = null;
      state.pendingRender = false;
      state.playing = false;
      state.index = -1;
      state.completed = false;
      state.queue = [];
      resetWords();
      cancelRendered();
      els.audio.pause();
      resetWebAudio();
      releaseAudioObjectUrl();
      els.audio.removeAttribute('src');
      els.audio.load();
      setPanelProgress(0);
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
      markReadable(node, entry);
      if (isGoogleDocsPage()) node.classList.add('sonora-docs-passage');
      knownBlocks.add(node);
    }));
    blockEntries = nextEntries;
    if (!isGoogleDocsPage()) scheduleCodeHover();
    if (!changed && isGoogleDocsPage() && state.queue.length) {
      // Continue through newly rendered pages after the queued snapshot. Keys
      // survive tile replacement and index shifts from earlier discoveries.
      const last = blockEntries.find(entry => entry.key === state.queue.at(-1).blockKey);
      if (last) {
        const remaining = MAX_PAGE_CHARS - state.queue.reduce((count, item) => count + item.text.length, 0);
        const queued = new Set(state.queue.map(item => item.blockKey));
        const added = queueFrom(last.index + 1, Math.max(0, remaining)).filter(item => !queued.has(item.blockKey));
        state.queue.push(...added);
        if (added.length && state.playing) prefetchAhead();
      }
    }
    if (!changed && state.index >= 0) {
      const item = state.queue[state.index];
      markCurrentBlock(item?.blockIndex, item?.blockKey);
      if (!state.completed) paintCurrentWord();
    }
    const updatedText = cleanText(nextEntries.map(entry => entry.text).join('\n\n'));
    pageText = updatedText.slice(0, MAX_PAGE_CHARS);
    updateMeta();
    if (isGoogleDocsPage() && state.ready && !state.queue.length) setStatus(readyMessage(), blockEntries.length ? 'ready' : 'error');
  }
  function markReadable(node, entry) {
    knownBlocks.add(node);
    if (isChatGPTPage() && node.closest('[data-testid^="conversation-turn-"],[data-message-id]')) return;
    node.classList.add(pageClass);
    node.classList.toggle('sonora-code-block', entry.kind === 'code');
  }
  function indexEntry(entry) {
    entriesByKey.set(entry.key, entry);
    (entry.nodes || [entry.node]).forEach(node => entriesByNode.set(node, entry));
    if (!entriesByScope.has(entry.scope)) entriesByScope.set(entry.scope, []);
    entriesByScope.get(entry.scope).push(entry);
    offerResume(entry);
    characterCount += entry.text.length;
    entryCount++;
    if (entry.kind === 'code') codeEntryCount++;
    if (activeHighlightEntry?.key === entry.key && activeHighlightEntry.node !== entry.node) markCurrentBlock(entry.index, entry.key);
  }
  function ensureOrderedEntries() {
    if (!orderedEntriesDirty) return;
    blockEntries = [...entriesByKey.values()].sort((a, b) => a.node === b.node ? 0 : (compareNodes(a.node, b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    blockEntries.forEach((entry, index) => { entry.index = index; });
    pageEntries = blockEntries;
    orderedEntriesDirty = false;
  }
  function updateMeta() {
    if (resumeEntry && (!entriesByKey.has(resumeEntry.key) || !matchesResume(resumeEntry))) {
      resumeEntry = null;
      updateTransport();
      if (state.ready && !state.queue.length) setStatus(readyMessage(), 'ready');
    }
    if (frameNotice) { els.meta.textContent = frameNotice; return; }
    if (!codeEntryCount) { codeMarks.forEach(boxes => boxes.forEach(box => box.remove())); codeMarks.clear(); }
    const size = characterCount + Math.max(0, entryCount - 1) * 2;
    const text = `${entryCount} clickable ${entryCount === 1 ? 'block' : 'blocks'} · ${size.toLocaleString()} characters${isGoogleDocsPage() && size > MAX_PAGE_CHARS ? ' · queues up to 240,000' : ''}`;
    if (els.meta.textContent !== text) els.meta.textContent = text;
  }

  function refreshBlocks() {
    if (refreshIdle !== null) cancelIdleCallback(refreshIdle);
    refreshIdle = null;
    refreshTimer = null;
    const navigated = !isGoogleDocsPage() && window.SonoraPassages.pageIdentity(sourceUrl) !== window.SonoraPassages.pageIdentity(location.href);
    if (!isGoogleDocsPage() && dirtyScopes.size && !fullRefreshPending && !navigated && source.root?.isConnected) {
      for (const [scope, node] of dirtyScopes) {
        scopeRefreshes.set(scope, { node, candidates: window.SonoraPassages.blockCandidates(node, source.noiseSelector, observeShadow), incoming: [], reading: null });
      }
      dirtyScopes.clear();
      if (scopeRefreshHandle === null) scopeRefreshHandle = setTimeout(refreshScopedBatch, 0);
      return;
    }
    if (scopeRefreshHandle !== null) clearTimeout(scopeRefreshHandle);
    scopeRefreshHandle = null;
    scopeRefreshes.clear();
    dirtyScopes.clear();
    fullRefreshPending = false;
    if (navigated) { stop(); state.queue = []; state.queueIterator = state.queueBlocks = state.queueStart = null; orderedEntriesDirty = false; pageEntries = []; reconcileEntries = window.SonoraPassages.createReconciler(); }
    if (sourceUrl !== location.href || !source.root?.isConnected) {
      const nextSource = findReadableSource();
      sourceUrl = location.href;
      source.root = nextSource.root;
      source.text = nextSource.text;
      source.title = nextSource.title;
      source.truncated = nextSource.truncated;
      source.noiseSelector = nextSource.noiseSelector;
      els.title.textContent = source.title || document.title || 'Untitled page';
      observeSource();
      if (CHATGPT_CONTAINMENT === 'coarse') setTurnContainment(true);
    }
    if (!isGoogleDocsPage()) { discoverPage(); return; }
    ensureOrderedEntries();
    knownBlocks.forEach(node => dirtyTextNodes.add(node));
    const nextBlocks = selectReadableBlocks(source.root, source.noiseSelector);
    updateBlocks(nextBlocks, navigated);
  }
  function refreshScopedBatch() {
    scopeRefreshHandle = null;
    if (state.closed) return;
    if ((performance.now() - lastPositionChange < 150 && !state.queueWaiting) || priorityReaders.size) {
      scopeRefreshHandle = setTimeout(refreshScopedBatch, 150); return;
    }
    const started = performance.now();
    do {
      const first = scopeRefreshes.entries().next();
      if (first.done) break;
      const [scope, job] = first.value;
      if (!job.node.isConnected) { job.incoming = []; job.reading = null; }
      if (job.reading) {
        const { node, reader, version } = job.reading;
        if (!node.isConnected) { job.reading = null; continue; }
        const result = reader.advance(2);
        if (!result.done) break;
        if (version !== (textVersions.get(node) || 0)) {
          job.reading = scopedReader(node); break;
        }
        extractionCache.set(node, { epoch: insertionEpoch, text: result.text, revision: ++domRevision });
        dirtyTextNodes.delete(node);
        job.incoming.push(...makeIncomingEntries([node]));
        job.reading = null;
      } else {
        const next = job.node.isConnected ? job.candidates.next() : { done: true };
        if (next.done) {
          scopeRefreshes.delete(scope);
          commitScopedEntries(scope, job.incoming);
          resumeDiscoveredQueue(); updateMeta();
          continue;
        }
        const node = next.value;
        if (!window.SonoraPassages.visibleBlock(node, isChatGPTPage())) continue;
        const cached = extractionCache.get(node);
        if (cached && !cached.partial && !isTextDirty(node)) job.incoming.push(...makeIncomingEntries([node]));
        else job.reading = scopedReader(node);
      }
    } while (performance.now() - started < 4);
    if (scopeRefreshes.size) scopeRefreshHandle = setTimeout(refreshScopedBatch, 16);
  }
  function scopedReader(node) {
    return { node, version: textVersions.get(node) || 0,
      reader: window.SonoraPassages.createTextReader(node.matches('pre') ? node.querySelector('code') || node : node, cleanText) };
  }
  function commitScopedEntries(scope, incoming) {
    const previous = entriesByScope.get(scope) || [];
    const next = reconcileEntries(previous, incoming);
    const activeItem = state.queue[state.index >= 0 ? state.index : (state.pendingStart ?? 0)];
    previous.forEach(entry => {
      characterCount -= entry.text.length; entryCount--;
      if (entry.kind === 'code') codeEntryCount--;
      entriesByKey.delete(entry.key); entriesByNode.delete(entry.node); knownBlocks.delete(entry.node);
      entry.node.classList.remove(pageClass, currentClass, 'sonora-code-block');
    });
    entriesByScope.delete(scope);
    next.forEach(entry => {
      indexEntry(entry); markReadable(entry.node, entry); includeQueuedEntry(entry);
    });
    if (activeItem && previous.some(entry => entry.key === activeItem.blockKey)) {
      const activeEntry = entriesByKey.get(activeItem.blockKey);
      if (activeEntry && !window.SonoraPassages.matchesPassage(activeEntry, activeItem)) {
        stop(); state.queue = []; setStatus('This passage changed — click it to read the updated text.', 'ready');
      } else if (activeEntry) markCurrentBlock(activeEntry.index, activeEntry.key);
    }
    orderedEntriesDirty = true;
  }
  function scheduleBlockRefresh(records) {
    if (sourceUrl !== location.href) pageType = pageTypeFor(location.href);
    const mutations = records && typeof records[Symbol.iterator] === 'function';
    if (mutations) {
      checkContainmentChanges(records);
      invalidateGeometry(records);
      // Class changes are observed only to keep the containment boundary safe.
      const siteClasses = value => String(value || '').split(/\s+/).filter(name => name && !name.startsWith('sonora-')).sort().join(' ');
      records = [...records].filter(record => record.type !== 'attributes' || record.attributeName !== 'class'
        || !isChatGPTPage() && siteClasses(record.oldValue) !== siteClasses(record.target.getAttribute('class')));
    }
    if (mutations && !isGoogleDocsPage()) {
      records = window.SonoraPassages.contentMutations(records, root, source.root);
      if (!records.length && sourceUrl === location.href) return;
    }
    wordTracker.invalidate();
    if (mutations) {
      for (const record of records) {
        let node = record.target?.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target;
        if (record.type === 'attributes' && node?.nodeType === Node.ELEMENT_NODE) insertedRoots.set(node, ++insertionEpoch);
        while (node && containsNode(source.root, node)) {
          dirtyTextNodes.add(node);
          textVersions.set(node, (textVersions.get(node) || 0) + 1);
          if (node === source.root) break;
          node = parentOf(node);
        }
        // Detached edits are not observed. Rediscover inserted subtrees from
        // their live text, including blocks excluded by an earlier extraction.
        for (const added of record.addedNodes || []) {
          if (added.nodeType !== Node.ELEMENT_NODE) continue;
          insertedRoots.set(added, ++insertionEpoch);
        }
      }
    }
    if (mutations && !isGoogleDocsPage()) {
      const batch = window.SonoraPassages.mutationScopes(records, root, source.root);
      batch.scopes.forEach(scopeNode => {
        const key = window.SonoraPassages.scopeFor(scopeNode);
        const previous = dirtyScopes.get(key);
        // Replacement records list both nodes. A removed copy must not hide
        // the live turn, including across observer batches before the flush.
        if (!previous || !containsNode(source.root, previous) || containsNode(source.root, scopeNode)) dirtyScopes.set(key, scopeNode);
      });
      fullRefreshPending ||= batch.full;
      if (!dirtyScopes.size && !fullRefreshPending && sourceUrl === location.href) return;
    } else fullRefreshPending = true;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      if (globalThis.requestIdleCallback) refreshIdle = requestIdleCallback(refreshBlocks, { timeout: 500 });
      else refreshBlocks();
    }, 100);
  }
  let discoveryHandle = null, discoveryGeneration = 0, indexingDone = false, discoveryFrontier = null;
  let panelPainted = false;
  let panelPaintFrame = requestAnimationFrame(() => {
    panelPaintFrame = requestAnimationFrame(() => { panelPaintFrame = null; setTurnContainment(true); panelPainted = true; });
  });
  let finishDiscovery;
  const whenIndexed = new Promise(resolve => { finishDiscovery = resolve; });
  function removeEntries(predicate) {
    const scopes = new Set();
    for (const [key, entry] of entriesByKey) {
      if (!predicate(entry)) continue;
      entriesByKey.delete(key); entriesByNode.delete(entry.node); knownBlocks.delete(entry.node);
      entry.node.classList.remove(pageClass, currentClass, 'sonora-code-block');
      characterCount -= entry.text.length; entryCount--; if (entry.kind === 'code') codeEntryCount--; scopes.add(entry.scope);
    }
    for (const scope of scopes) {
      const remaining = entriesByScope.get(scope)?.filter(entry => entriesByKey.has(entry.key));
      if (remaining?.length) entriesByScope.set(scope, remaining); else entriesByScope.delete(scope);
    }
    blockEntries = blockEntries.filter(entry => entriesByKey.has(entry.key));
  }
  function discoverPage() {
    if (isGoogleDocsPage()) { updateBlocks(source.blocks); finishDiscovery(); return; }
    if (discoveryHandle !== null) clearTimeout(discoveryHandle);
    const generation = ++discoveryGeneration;
    indexingDone = false;
    discoveryFrontier = null;
    removeEntries(entry => !entry.node.isConnected || !containsNode(source.root, entry.node));
    const seenNodes = new Set();
    const existing = new Map([...entriesByKey.values()].map(entry => [entry.node, entry.domRevision]));
    const candidates = window.SonoraPassages.blockCandidates(source.root, source.noiseSelector, observeShadow);
    let reading = null;
    function batch() {
      discoveryHandle = null;
      if (state.closed || generation !== discoveryGeneration) return;
      if (!panelPainted && !document.hidden) { discoveryHandle = setTimeout(batch, 16); return; }
      if (performance.now() - lastPositionChange < 150 && !state.queueWaiting) { discoveryHandle = setTimeout(batch, 150); return; }
      if (priorityReaders.size) { discoveryHandle = setTimeout(batch, 16); return; }
      const started = performance.now();
      do {
        if (reading && !reading.node.isConnected) reading = null;
        if (reading && entriesByNode.has(reading.node) && !entriesByNode.get(reading.node).partial && !isTextDirty(reading.node)) reading = null;
        if (reading) {
          const result = reading.reader.advance(2);
          if (!result.done) break;
          const { node } = reading;
          if (reading.version !== (textVersions.get(node) || 0)) {
            reading = { node, version: textVersions.get(node) || 0, reader: window.SonoraPassages.createTextReader(node.matches('pre') ? node.querySelector('code') || node : node, cleanText) };
            break;
          }
          if (!node.isConnected) { reading = null; continue; }
          extractionCache.set(node, { epoch: insertionEpoch, text: result.text, revision: ++domRevision });
          dirtyTextNodes.delete(node);
          const old = entriesByNode.get(node);
          if (old) {
            const updated = makeIncomingEntries([node])[0];
            if (!updated) { removeEntries(entry => entry === old); reading = null; continue; }
            characterCount -= old.text.length;
            Object.assign(old, updated);
            characterCount += old.text.length;
            const active = state.queue[state.index >= 0 ? state.index : (state.pendingStart ?? 0)];
            if (active?.blockKey === old.key && !window.SonoraPassages.matchesPassage(old, active)) { stop(); state.queue = []; setStatus('This passage changed — click it to read the updated text.', 'ready'); }
            const snapshot = state.queueBlocks?.find(block => block.key === old.key);
            if (snapshot?.partial && old.text.startsWith(snapshot.text)) Object.assign(snapshot, { text: old.text, partial: false });
          } else addDiscovered(node);
          reading = null;
        } else {
          const next = candidates.next();
          if (next.done) { removeEntries(entry => !entry.node.isConnected || !containsNode(source.root, entry.node) || existing.get(entry.node) === entry.domRevision && !seenNodes.has(entry.node)); indexingDone = true; orderedEntriesDirty = true; if (resumeRecord) for (const entry of entriesByKey.values()) offerResume(entry); finishDiscovery(); resumeDiscoveredQueue(); updateMeta(); return; }
          const node = next.value;
          discoveryFrontier = node;
          if (!window.SonoraPassages.visibleBlock(node, isChatGPTPage())) continue;
          seenNodes.add(node);
          if (entriesByNode.has(node) && !entriesByNode.get(node).partial && !isTextDirty(node)) continue;
          reading = { node, version: textVersions.get(node) || 0, reader: window.SonoraPassages.createTextReader(node.matches('pre') ? node.querySelector('code') || node : node, cleanText) };
        }
      } while (performance.now() - started < 4);
      resumeDiscoveredQueue();
      updateMeta();
      discoveryHandle = setTimeout(batch, codeScrolling ? 150 : 16);
    }
    function addDiscovered(node) {
      for (const entry of reconcileEntries([], makeIncomingEntries([node]))) {
        entry.index = blockEntries.length;
        indexEntry(entry); blockEntries.push(entry);
        markReadable(node, entry);
        includeQueuedEntry(entry);
      }
    }
    // Give the panel its first paint and install click handlers before indexing.
    discoveryHandle = setTimeout(batch, 50);
  }
  function includeQueuedEntry(entry) {
    const snapshot = state.queueBlocks;
    if (!snapshot || !(compareNodes(snapshot[0].node, entry.node) & Node.DOCUMENT_POSITION_FOLLOWING)
      || snapshot.some(block => block.key === entry.key)) return;
    let low = 1, high = snapshot.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compareNodes(snapshot[middle].node, entry.node) & Node.DOCUMENT_POSITION_FOLLOWING) low = middle + 1;
      else high = middle;
    }
    // Preserve the buffered reading order through earlier insertions. Adding
    // before its tail could replay blocks already consumed by the iterator.
    const buffered = state.queue.at(-1);
    const tail = buffered && snapshot.find(block => block.key === buffered.blockKey);
    if (tail && (compareNodes(entry.node, tail.node) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
    snapshot.splice(low, 0, { ...entry });
    // The old tail may already be buffered, leaving an exhausted iterator.
    // Continue at newly appended content without replaying that buffered tail.
    if (!state.queueIterator && !state.completed && state.index >= 0) {
      state.queueIterator = queuedPassages(snapshot, 0, low, false);
    }
  }
  discoverPage();
  source.blocks = [];
  const pageClickListener = event => {
    if (!readingGesture(event)) return;
    const target = event.composedPath?.().find(node => node instanceof Element) || event.target;
    if (!(target instanceof Element)) return;
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
    let block = target.closest(`.${pageClass}`) || target.closest(window.SonoraPassages.blockSelector);
    for (let parent = block?.parentElement; parent && containsNode(source.root, parent); parent = parent.parentElement) {
      if (entriesByNode.has(parent)) { block = parent; break; }
    }
    if (!block) {
      for (let node = target; node && containsNode(source.root, node); node = parentOf(node)) {
        if ((node.matches('div,section,span') || node === source.root) && !node.querySelector(window.SonoraPassages.blockSelector)
          && [...node.childNodes].some(child => child.nodeType === 3 && /\S/u.test(child.data))) block = node;
        if (node === source.root) break;
      }
    }
    if (!block || !containsNode(source.root, block) || block.closest(source.noiseSelector)
      || window.SonoraPassages.isCodeChrome(block, source.root)) return;
    if (!entriesByNode.has(block)) {
      for (const entry of reconcileEntries([], makeIncomingEntries([block], 2400))) {
        entry.index = blockEntries.length;
        indexEntry(entry); blockEntries.push(entry); knownBlocks.add(block);
        markReadable(block, entry);
      }
    }
    handlePageClick(event, block);
  };
  document.addEventListener('click', pageClickListener, true);
  function readingGesture(event) {
    const target = event.composedPath?.().find(node => node instanceof Element) || event.target;
    return !els.panel.classList.contains('is-hidden') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && !(target instanceof Element && window.SonoraPassages.closest(target, window.SonoraPassages.editableSelector));
  }
  const docsPointerDownListener = event => {
    if (!readingGesture(event)) return;
    if (event.target === root) return;
    if (!isGoogleDocsPage()) {
      const target = event.target instanceof Element ? event.target : null;
      const code = target?.closest('pre');
      if (event.button === 0 && code && containsNode(source.root, code) && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
        && !target.closest('button,input,textarea,select,[role="button"],a,[role="link"]')) event.preventDefault();
      return;
    }
    const surface = googleDocsSurface(source.root);
    if (!surface?.closest('.kix-appview-editor')?.contains(event.target)) return;
    const entry = window.SonoraDocs.hitTest(blockEntries, event.clientX, event.clientY);
    if (entry) handlePageClick(event, entry.node);
  };
  document.addEventListener('pointerdown', docsPointerDownListener, true);
  const docsPointerListener = event => {
    if (!indexingDone || containmentScan) lastPositionChange = performance.now();
    if (!isGoogleDocsPage()) {
      if (!codeEntryCount) return;
      const target = event.target instanceof Element ? event.target : null;
      const block = target?.closest('pre');
      if (!block && !codeHoverPoint?.block) return;
      codeHoverPoint = { x: event.clientX, y: event.clientY, block };
      if (!codeScrolling) scheduleCodeHover(true);
      return;
    }
    const surface = googleDocsSurface(source.root);
    const next = surface?.closest('.kix-appview-editor')?.contains(event.target) ? window.SonoraDocs.hitTest(blockEntries, event.clientX, event.clientY) : null;
    if (docsHover === next) return;
    docsHover?.nodes.forEach(node => node.classList.remove('sonora-hover-block'));
    docsHover = next;
    docsHover?.nodes.forEach(node => node.classList.add('sonora-hover-block'));
  };
  document.addEventListener('pointermove', docsPointerListener, { capture: true, passive: true });
  const wheelActivityListener = event => {
    if (!relevantScroll(event)) return;
    if (!indexingDone || containmentScan || state.queue.length || codeHoverPoint?.block || codeMarks.size) wordPositionListener();
    if (state.queue.length) followReading = false;
  };
  document.addEventListener('wheel', wheelActivityListener, { capture: true, passive: true });
  const wordPositionListener = event => {
    if (!relevantScroll(event)) return;
    // Scrolling is user-owned. Suspend geometry/paint until it settles; never
    // materialize an off-screen turn just to follow an inaudible visual mark.
    lastPositionChange = performance.now();
    if (!state.queue.length && !codeHoverPoint?.block && !codeMarks.size) return;
    if (lastPositionChange > autoScrollUntil) followReading = false;
    if (codeScrolling) return;
    codeScrolling = true;
    delete pendingPanel.progress;
    stopWordFrames();
    if (positionFrame === null) positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      wordTracker.suspend();
      markCodePart(null, null, 'sonora-current-code');
      markCodePart(null, null, 'sonora-hover-code');
    });
    function settled() {
      codeScrollTimer = null;
      if (performance.now() - lastPositionChange < 150) { codeScrollTimer = setTimeout(settled, 150); return; }
      codeScrolling = false;
      wordTracker.invalidate();
      if (state.playing) startWordFrames();
      else if (state.index >= 0 && !state.completed) paintCurrentWord();
      if (state.webAudioBuffer) updateProgress(webAudioPosition());
      if (codeHoverPoint) codeHoverPoint.block = undefined;
      scheduleCodeHover(true);
    }
    codeScrollTimer = setTimeout(settled, 150);
  };
  document.addEventListener('scroll', wordPositionListener, { capture: true, passive: true });
  window.addEventListener('resize', wordPositionListener, { passive: true });
  window.addEventListener('popstate', scheduleBlockRefresh);
  window.addEventListener('hashchange', scheduleBlockRefresh);
  const pageObserver = new MutationObserver(records => {
    // React can move the same conversation beneath new wrappers. Rebind the
    // shallow ancestor watches without rediscovering its unchanged passages.
    if (source.root?.isConnected && records.some(record => !containsNode(source.root, record.target)
      && [...record.removedNodes].some(node => node.nodeType === 1 && node.contains(source.root)))) {
      observeSource();
      wordPositionListener();
    }
    scheduleBlockRefresh(records);
  });
  const shadowRoots = new Set();
  const observerOptions = { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true,
    attributeFilter: ['hidden', 'aria-hidden', 'style', 'open', ...(!isChatGPTPage() || visibilityStyle && CHATGPT_CONTAINMENT === 'coarse' ? ['class'] : [])] };
  function observeShadow(shadow) {
    if (shadowRoots.has(shadow)) return;
    shadowRoots.add(shadow);
    pageObserver.observe(shadow, observerOptions);
  }
  const observeSource = () => {
    pageObserver.disconnect();
    const rootNode = source.root || document.body || document.documentElement;
    if (!rootNode) return false;
    pageObserver.observe(rootNode, observerOptions);
    for (const shadow of shadowRoots) {
      if (!shadow.host.isConnected || !containsNode(rootNode, shadow.host)) shadowRoots.delete(shadow);
      else pageObserver.observe(shadow, observerOptions);
    }
    // Watch only direct child replacement on the ancestor chain. Sidebar and
    // composer traffic outside the source needs no subtree observer.
    for (let ancestor = rootNode.parentElement; ancestor; ancestor = ancestor.parentElement) pageObserver.observe(ancestor, { childList: true });
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
  els.play.addEventListener('click', async () => {
    if (resumeEntry && (!matchesResume(resumeEntry) || isTextDirty(resumeEntry.node))) resumeEntry = null;
    if (!state.queue.length && resumeEntry && resumeRecord) {
      const entry = resumeEntry, offset = resumeRecord.offset;
      primeAudioContext(); startQueue(entry.index, offset, entry); return;
    }
    if (documentPort && !ownsPlayback && !state.playing && !state.pendingRender && !await claimPlayback()) return;
    if (state.playing || state.pendingRender || state.pendingStart !== null || state.queueWaiting) {
      state.pendingStart = null;
      pausePlayback();
      state.playing = false;
      updateTransport();
      setStatus('Paused', 'ready');
    } else if (state.queueEnded) {
      advanceQueue();
    } else if (!state.completed && state.webAudioBuffer && state.index >= 0) {
      const revision = state.revision;
      playWebAudio(state.webAudioSourceData, revision, state.webAudioOffset).then(started => {
        if (!started || revision !== state.revision || state.closed) return;
        state.playing = true;
        startWordFrames();
        updateTransport();
        setStatus(`Playing passage ${passageLabel()}`, 'ready');
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
        setStatus(`Playing passage ${passageLabel()}`, 'ready');
      }).catch(error => {
        if (revision === state.revision && !state.closed) setStatus(error.message, 'error');
      });
    } else if (state.queue.length && !isGoogleDocsPage() && state.queueStart && (state.completed || state.index < 0)) {
      const { entry, offset } = state.queueStart;
      startQueue(entry.index, offset, entriesByKey.get(entry.key) || entry);
    } else if (state.queue.length) {
      const resumeIndex = state.index >= 0 && !state.completed ? state.index : 0;
      state.pendingStart = resumeIndex;
      if (state.ready) { state.pendingStart = null; play(resumeIndex); }
      else setStatus('Waiting for the local voice to finish warming up…', 'busy');
    } else if (!blockEntries.length && !indexingDone) {
      setStatus('Finding the first passage…', 'busy');
      whenIndexed.then(() => { if (!state.closed && !state.queue.length) startQueue(0); });
    } else startQueue(0);
  });
  els.stop.addEventListener('click', stop);
  els.audio.addEventListener('timeupdate', () => {
    if (codeScrolling) return;
    const part = els.audio.duration ? els.audio.currentTime / els.audio.duration : 0;
    setPanelProgress(Math.min(1, (state.index + part) / Math.max(1, state.queue.length)));
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
    state.queueEnded = true;
    fillQueue();
    if (state.index + 1 < state.queue.length) {
      if (state.index >= 31 && !isGoogleDocsPage()) {
        const removed = state.index + 1;
        state.queue.splice(0, removed);
        state.queueOffset += removed;
        state.rendered = new Map([...state.rendered].filter(([index]) => index >= removed).map(([index, value]) => [index - removed, value]));
        state.renderRequests = new Map([...state.renderRequests].filter(([index]) => index >= removed).map(([index, value]) => [index - removed, value]));
        state.index = -1;
      }
      play(state.index + 1);
    }
    else if (state.queueIterator || !isGoogleDocsPage() && (scopeRefreshes.size || dirtyScopes.size || fullRefreshPending)) {
      state.queueWaiting = true;
      state.pendingRender = false;
      resetWords();
      updateTransport();
      setStatus('Finding the next passage…', 'busy');
    } else {
      state.queueWaiting = false;
      state.queueEnded = false;
      state.pendingRender = false;
      state.completed = true;
      savedPositions = savedPositions.filter(record => record.document !== window.SonoraPassages.pageIdentity(location.href));
      if (documentPort) message({ type: 'sonora-save-position', document: window.SonoraPassages.pageIdentity(location.href) }).catch(() => {});
      else saveSetting('sonoraPositions', savedPositions);
      resetWords();
      setPanelProgress(1);
      updateTransport();
      setStatus('Page section complete — click another block to jump.', 'ready');
    }
  }
  function resumeDiscoveredQueue() {
    if (!state.queueWaiting || state.closed) return;
    fillQueue();
    if (state.index + 1 < state.queue.length || !state.queueIterator) {
      state.queueWaiting = false;
      advanceQueue();
    }
  }
  els.speed.addEventListener('input', () => {
    applySpeed(els.speed.value, true);
    if (state.webAudioSource || (state.playing && state.webAudioBuffer)) {
      const position = webAudioPosition();
      pauseWebAudio();
      const revision = state.revision;
      playWebAudio(state.webAudioSourceData, revision, position).then(started => {
        if (started && revision === state.revision && !state.closed) {
          state.playing = true;
          startWordFrames();
        }
      }).catch(error => {
        if (revision !== state.revision || state.closed) return;
        state.playing = false;
        updateTransport();
        setStatus(error.message, 'error');
      });
    }
    updateTransport();
  });
  els.voice.addEventListener('change', () => {
    saveSetting('sonoraVoice', els.voice.value);
    const item = state.queue[state.index];
    ensureOrderedEntries();
    const currentBlock = item?.blockKey ? entriesByKey.get(item.blockKey)?.index : item?.blockIndex;
    const hadQueue = state.queue.length > 0;
    stop();
    if (currentBlock !== undefined) startQueue(currentBlock);
    else if (hadQueue) startQueue(0);
  });
  function togglePanel() {
    els.panel.classList.toggle('is-hidden');
  }
  els.minimize.addEventListener('click', togglePanel);
  const leaveDocument = () => {
    ownsPlayback = false;
    state.revision++;
    state.pendingStart = null;
    pausePlayback();
    message({ type: 'sonora-document-left' }).catch(() => {});
  };
  window.addEventListener('pagehide', leaveDocument);
  els.close.addEventListener('click', () => {
    savePosition();
    resetWords();
    wordTracker.reset(true); codeRange.reset();
    state.queueIterator = null; state.queueBlocks = state.queueStart = null; state.queue = [];
    entriesByKey.clear(); entriesByScope.clear(); blockEntries = pageEntries = [];
    state.closed = true;
    updateMediaSession();
    clickRevision++;
    state.revision++;
    cancelRendered();
    els.audio.pause();
    resetWebAudio();
    state.audioContext?.close().catch(() => {});
    state.audioContext = null;
    decodedAudio = null;
    releaseAudioObjectUrl();
    pageObserver.disconnect();
    shadowRoots.clear();
    setTurnContainment(false, true);
    document.removeEventListener('contentvisibilityautostatechange', visibilityListener, true);
    chrome.runtime.onMessage?.removeListener(renderReadyListener);
    window.removeEventListener('pagehide', leaveDocument);
    documentPort?.disconnect();
    document.removeEventListener('click', pageClickListener, true);
    document.removeEventListener('pointerdown', docsPointerDownListener, true);
    document.removeEventListener('pointermove', docsPointerListener, true);
    document.removeEventListener('wheel', wheelActivityListener, true);
    document.removeEventListener('scroll', wordPositionListener, true);
    window.removeEventListener('resize', wordPositionListener);
    window.removeEventListener('popstate', scheduleBlockRefresh);
    window.removeEventListener('hashchange', scheduleBlockRefresh);
    if (refreshTimer) clearTimeout(refreshTimer);
    if (refreshIdle !== null) cancelIdleCallback(refreshIdle);
    if (scopeRefreshHandle !== null) clearTimeout(scopeRefreshHandle);
    scopeRefreshes.clear();
    if (discoveryHandle !== null) clearTimeout(discoveryHandle);
    if (panelPaintFrame !== null) cancelAnimationFrame(panelPaintFrame);
    discoveryGeneration++;
    if (codeHoverFrame !== null) cancelAnimationFrame(codeHoverFrame);
    if (codeHoverTimer !== null) clearTimeout(codeHoverTimer);
    if (codeScrollTimer !== null) clearTimeout(codeScrollTimer);
    if (positionFrame !== null) cancelAnimationFrame(positionFrame);
    if (geometryFrame !== null) cancelAnimationFrame(geometryFrame);
    if (panelWriteFrame !== null) cancelAnimationFrame(panelWriteFrame);
    clearInterval(navigationTimer);
    if (state.voiceTimer) clearTimeout(state.voiceTimer);
    knownBlocks.forEach(node => node.classList.remove(pageClass, currentClass, 'sonora-docs-passage', 'sonora-hover-block', 'sonora-code-block'));
    window.CSS?.highlights?.delete('sonora-hover-code');
    codeMarks.forEach(boxes => boxes.forEach(box => box.remove())); codeMarks.clear();
    clearCurrentBlock();
    root.remove();
    delete window.__sonoraOverlay;
  });
  window.__sonoraOverlay = {
    version: OVERLAY_VERSION,
    whenIndexed,
    whenContained,
    toggle: togglePanel,
    show: () => els.panel.classList.remove('is-hidden'),
    setFrameChoice,
    setFrameNotice(notice) {
      frameNotice = notice;
      if (notice) els.panel.classList.remove('is-hidden');
      updateMeta();
      if (!state.queue.length) setStatus(readyMessage(), notice ? 'error' : 'ready');
    },
    dispose: () => els.close.click()
  };
  loadSettings();
  checkVoice();

  function readableText(node, limit = Infinity) {
    if (!node) return '';
    const cached = extractionCache.get(node);
    if (cached && !isTextDirty(node) && (!cached.partial || limit < Infinity)) return cached.text;
    const contentNode = node.matches?.('pre') ? node.querySelector('code') || node : node;
    const text = isGoogleDocsPage() && contentNode.matches?.('g[role="paragraph"]')
      ? cleanText([...contentNode.querySelectorAll('rect[aria-label]')].map(rect => rect.getAttribute('aria-label')).join(' '))
      : window.SonoraPassages.readableText(contentNode, cleanText, limit);
    extractionCache.set(node, { epoch: insertionEpoch, text, revision: ++domRevision, partial: limit < Infinity && contentNode.textContent.length >= limit });
    dirtyTextNodes.delete(node);
    return text;
  }

  function pageTypeFor(url) {
    const parsed = new URL(url);
    return { docs: /(^|\.)docs\.google\.com$/i.test(parsed.hostname) && /^\/document\//.test(parsed.pathname),
      chat: /^(chatgpt\.com|chat\.openai\.com)$/i.test(parsed.hostname) };
  }
  function isGoogleDocsPage() { return pageType.docs; }
  function isChatGPTPage() { return pageType.chat; }

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
    const incoming = makeIncomingEntries(nodes);
    pageEntries = reconcileEntries(pageEntries, incoming);
    orderedEntriesDirty = false;
    return pageEntries;
  }

  function makeIncomingEntries(nodes, limit = Infinity) {
    return nodes.map(node => {
      const text = readableText(node, limit);
      const cached = extractionCache.get(node);
      return { node, text, noWordTracking: window.SonoraPassages.syntheticText(node), useRectangles: isChatGPTPage() || Boolean(node.getRootNode().host), partial: Boolean(cached.partial), domRevision: cached.revision, scope: window.SonoraPassages.scopeFor(node), ...(node.matches('pre')
        ? { kind: 'code', contentNode: node.querySelector('code') || node } : {}) };
    })
      .filter(entry => entry.kind === 'code' ? entry.partial || /[\p{L}\p{N}]/u.test(entry.text)
        : /[\p{L}\p{N}]/u.test(entry.text));
  }

  function selectReadableBlocks(root, noiseSelector) {
    if (!root) return [];
    if (isGoogleDocsPage()) {
      const surface = googleDocsSurface(root);
      return surface ? [...surface.querySelectorAll('svg g[role="paragraph"]')].filter(node => node.querySelector('rect[aria-label]')) : [];
    }
    return [...window.SonoraPassages.blockCandidates(root, noiseSelector)].filter(node => {
      if (!window.SonoraPassages.visibleBlock(node, isChatGPTPage())) return false;
      const value = readableText(node);
      return /[\p{L}\p{N}]/u.test(value);
    });
  }

  function findReadableSource() {
    const noiseSelector = [
      'script', 'style', 'noscript', 'template', 'nav', 'header', 'footer', 'aside', 'form',
      window.SonoraPassages.editableSelector, '#hnmain .comhead', '#hnmain .reply', '#hnmain .pagetop', '#hnmain .subtext',
      '[role="dialog"]', '[aria-modal="true"]', '[role="complementary"]', '.subscribe-widget', '.subscription-widget', '.paywall', '.baseline-indicator',
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
    const chat = isChatGPTPage();
    const firstReadable = selector => [...document.querySelectorAll(selector)].find(node => !node.closest(noiseSelector));
    let root = chat ? document.querySelector('[role="region"][aria-label="Conversation"]') || document.querySelector('main') || document.body
      : firstReadable('#mw-content-text .mw-parser-output, #mw-content-text')
        || firstReadable('main,[role="main"],.post-content,.article-content,.entry-content,.markdown-body')
        || firstReadable('article')
        || document.body || document.documentElement;
    if (!chat) {
      const articles = root.querySelectorAll('article');
      const prose = root.querySelector('#readme article, article.markdown-body, [itemprop=\"articleBody\"]');
      if (prose && !prose.closest(noiseSelector)) root = prose;
      else if (articles.length === 1 && !articles[0].closest(noiseSelector)) root = articles[0];
    }
    return { root, blocks: [], text: '', noiseSelector, title: cleanText(document.title || 'Untitled page') };
  }
})();
