const $ = (id) => document.getElementById(id);
const validation = globalThis.SonoraValidation;
const els = { title: $('source-title'), url: $('source-url'), text: $('selected-text'), count: $('passage-count'), chars: $('character-count'), status: $('status'), dot: $('status-dot'), voice: $('voice'), speed: $('speed'), speedValue: $('speed-value'), progress: $('progress'), play: $('play'), playIcon: $('play-icon'), playLabel: $('play-label'), stop: $('stop'), audio: $('audio'), server: $('server') };
const state = { text: '', chunks: [], index: 0, rendered: new Map(), playing: false, generation: 0, audioGeneration: 0, ready: false, autoplay: false, autoAttempted: false, checkTimer: null, api: validation.DEFAULT_SERVER };
els.audio.preservesPitch = true;

function setStatus(message, mode = '') { els.status.textContent = message; els.dot.className = `status-dot ${mode}`; }
function splitText(value) {
  const normalized = window.BookText.cleanText(value);
  if (!normalized) return [];
  const first = window.BookText.chunksFor(normalized, 700)[0];
  if (!first || normalized.length <= first.length) return first ? [first] : [];
  const rest = normalized.slice(normalized.indexOf(first) + first.length).trim();
  return [first, ...window.BookText.chunksFor(rest, 3600)];
}
function displaySelection(selection) {
  state.text = typeof selection?.text === 'string' ? selection.text.trim() : '';
  state.chunks = state.text ? splitText(state.text) : [];
  state.index = 0; state.rendered.clear(); state.generation++;
  state.autoplay = Boolean(selection?.autoplay); state.autoAttempted = false;
  els.title.textContent = typeof selection?.title === 'string' && selection.title.trim() ? selection.title.trim() : (state.text ? 'Selected text' : 'Ready to read');
  try { els.url.textContent = selection?.pageUrl ? new URL(selection.pageUrl).hostname : ''; } catch { els.url.textContent = ''; }
  els.text.textContent = state.text || 'Highlight text on a page, then choose “Read selection with Sonora”.';
  els.count.textContent = state.chunks.length ? `${state.chunks.length} ${state.chunks.length === 1 ? 'passage' : 'passages'}` : 'No selection';
  els.chars.textContent = state.text ? `${state.text.length.toLocaleString()} characters` : '';
  els.play.disabled = !state.chunks.length || !state.ready;
  els.progress.style.width = '0%';
  if (state.ready && state.autoplay && !state.autoAttempted && state.chunks.length) { state.autoAttempted = true; playCurrent(); }
}
async function loadSelection() {
  try {
    const data = await chrome.storage.session.get('pendingSelection');
    if (data.pendingSelection) await chrome.storage.session.remove('pendingSelection');
    displaySelection(data.pendingSelection);
  } catch {
    displaySelection(null);
  }
}
async function loadSettings() {
  try {
    const saved = await chrome.storage.local.get(['sonoraServer', 'sonoraSpeed', 'sonoraVoice']);
    state.api = validation.normalizeServerUrl(saved.sonoraServer);
    els.server.value = state.api;
    const speed = Number(saved.sonoraSpeed);
    if (Number.isFinite(speed) && speed >= 0.6 && speed <= 2) { els.speed.value = String(speed); updateSpeed(); }
    if (saved.sonoraVoice && [...els.voice.options].some(option => option.value === saved.sonoraVoice)) els.voice.value = saved.sonoraVoice;
  } catch {
    els.server.value = state.api;
  }
}
function updateSpeed() { const raw = Number(els.speed.value); const speed = Number.isFinite(raw) ? Math.min(2, Math.max(0.6, raw)) : 1; els.speed.value = String(speed); els.speedValue.textContent = `${speed.toFixed(speed % 1 ? 2 : 0)}×`; els.audio.playbackRate = speed; chrome.storage.local.set({ sonoraSpeed: speed }).catch?.(() => {}); }
async function request(path, options = {}) {
  state.api = validation.normalizeServerUrl(state.api);
  const response = await fetch(`${state.api}${path}`, options);
  let data; try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || `Sonora returned ${response.status}.`);
  return data;
}
async function checkVoice() {
  try {
    const data = await request('/api/narration/status');
    state.ready = data.ready;
    if (data.ready) {
      if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }
      setStatus('Local voice ready', 'ready');
      if (state.autoplay && !state.autoAttempted && state.chunks.length) { state.autoAttempted = true; playCurrent(); }
    } else {
      setStatus(data.state === 'loading' ? 'Warming up the local voice…' : (data.message || 'Start the Sonora server to continue.'), data.state === 'loading' ? 'busy' : 'error');
      if (state.checkTimer) clearTimeout(state.checkTimer);
      state.checkTimer = setTimeout(() => { state.checkTimer = null; checkVoice(); }, data.state === 'loading' ? 2500 : 5000);
    }
    els.play.disabled = !state.chunks.length || !state.ready;
  } catch (error) {
    state.ready = false;
    setStatus('Sonora is offline — start npm start in the book-to-voice folder.', 'error');
    els.play.disabled = true;
    if (state.checkTimer) clearTimeout(state.checkTimer);
    state.checkTimer = setTimeout(() => { state.checkTimer = null; checkVoice(); }, 3000);
  }
}
async function render(index) {
  if (state.rendered.has(index)) return state.rendered.get(index);
  const promise = request('/api/narration/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: state.chunks[index], voice: els.voice.value }) }).then(data => {
    if (!data?.audioUrl) throw new Error('Sonora returned no playable audio.');
    return { ...data, src: validation.audioUrlFor(state.api, data.audioUrl).href };
  });
  state.rendered.set(index, promise);
  try { return await promise; } catch (error) { state.rendered.delete(index); throw error; }
}
function updateTransport() { els.play.classList.toggle('is-playing', state.playing); els.playIcon.textContent = state.playing ? 'Ⅱ' : '▶'; els.playLabel.textContent = state.playing ? 'Pause' : 'Read aloud'; }
function trimRendered(index) {
  for (const key of state.rendered.keys()) {
    if (key < index || key > index + 1) state.rendered.delete(key);
  }
}
async function playCurrent() {
  if (!state.chunks.length) return;
  const generation = state.generation; const current = state.index;
  trimRendered(current);
  setStatus(state.chunks.length > 1 ? `Rendering passage ${current + 1} of ${state.chunks.length}…` : 'Rendering selection…', 'busy');
  try {
    const rendered = await render(current); if (generation !== state.generation) return;
    state.audioGeneration = generation;
    els.audio.src = rendered.src; els.audio.currentTime = 0; els.audio.playbackRate = Number(els.speed.value); await els.audio.play();
    if (generation !== state.generation) { els.audio.pause(); return; }
    state.playing = true; setStatus(`Playing passage ${current + 1} of ${state.chunks.length}`, 'ready'); updateTransport();
    if (current + 1 < state.chunks.length) render(current + 1).catch(() => {});
  } catch (error) {
    if (generation !== state.generation) return;
    state.playing = false;
    updateTransport();
    setStatus(error.name === 'NotAllowedError' ? 'Audio is ready. Press Read aloud to begin.' : error.message, 'error');
  }
}
function stop() { state.generation++; state.playing = false; els.audio.pause(); els.audio.removeAttribute('src'); els.progress.style.width = '0%'; updateTransport(); if (state.ready) setStatus('Ready to read', 'ready'); }
els.play.addEventListener('click', () => {
  if (state.playing) { els.audio.pause(); state.playing = false; updateTransport(); setStatus('Paused', 'ready'); }
  else if (els.audio.src && state.index >= 0) {
    const generation = state.generation;
    els.audio.play().then(() => { if (generation !== state.generation) return; state.playing = true; updateTransport(); }).catch(error => { if (generation === state.generation) setStatus(error.message, 'error'); });
  } else playCurrent();
});
els.stop.addEventListener('click', stop);
els.audio.addEventListener('timeupdate', () => { const percent = els.audio.duration ? ((els.audio.currentTime / els.audio.duration) * 100) : 0; els.progress.style.width = `${percent}%`; });
els.audio.addEventListener('ended', () => {
  if (state.audioGeneration !== state.generation) return;
  if (state.index + 1 < state.chunks.length) { state.index++; playCurrent(); }
  else { state.playing = false; updateTransport(); setStatus('Selection complete', 'ready'); els.progress.style.width = '100%'; }
});
els.speed.addEventListener('input', updateSpeed);
els.voice.addEventListener('change', () => { chrome.storage.local.set({ sonoraVoice: els.voice.value }).catch?.(() => {}); state.rendered.clear(); stop(); });
els.server.addEventListener('change', () => { const value = validation.normalizeServerUrl(els.server.value); state.api = value; els.server.value = value; chrome.storage.local.set({ sonoraServer: value }).catch?.(() => {}); state.rendered.clear(); stop(); state.ready = false; els.play.disabled = true; checkVoice(); });
loadSettings().then(() => Promise.all([loadSelection(), checkVoice()])).catch(() => checkVoice());
