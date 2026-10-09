const PDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.min.mjs';
const ZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
const $ = (id) => document.getElementById(id);
const els = {
  landing: $('landing-view'), reader: $('reader-view'), input: $('book-input'), sample: $('sample-btn'), reset: $('reset-btn'), railImport: $('rail-import'),
  chip: $('engine-chip'), chipText: $('engine-chip').querySelector('span'), toast: $('toast'), bookTitle: $('book-title'), bookMeta: $('book-meta'), list: $('chapter-list'),
  chapterTitle: $('chapter-title'), chapterSubtitle: $('chapter-subtitle'), progressCopy: $('progress-copy'), progressBar: $('reading-progress-bar'), bookText: $('book-text'),
  voiceOrb: $('voice-orb'), voiceState: $('voice-state'), voiceDetail: $('voice-detail'), voiceSelect: $('voice-select'), listen: $('listen-btn'), audio: $('audio')
};
const state = { book: null, current: 0, voiceReady: false, voiceState: 'loading', queue: [], queueIndex: -1, playing: false, words: [], currentPassage: '', generation: 0, browserUtterance: null };

function showToast(message, ms = 3800) { els.toast.textContent = message; els.toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove('show'), ms); }
function escapeHTML(value) { return value.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function formatMinutes(chars) { return Math.max(1, Math.round(chars / 950)); }
const { cleanText, chunksFor } = window.BookText;
function paragraphs(text) { return text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean); }
function buildChapters(raw) {
  const text = cleanText(raw);
  const lines = text.split('\n');
  const markers = [];
  let cursor = 0;
  for (const line of lines) {
    if (/^\s*(chapter\s+[0-9ivxlcdm]+(?:\s*[:.—-].*)?|book\s+[0-9ivxlcdm]+.*)$/i.test(line.trim()) && line.trim().length < 100) markers.push({ title: line.trim().replace(/\s+/g, ' '), at: cursor });
    cursor += line.length + 1;
  }
  if (markers.length >= 2) {
    return markers.map((marker, i) => {
      const end = i + 1 < markers.length ? markers[i + 1].at : text.length;
      const body = text.slice(marker.at + lines.slice(0, 0).join('').length, end).replace(/^.*?\n/, '').trim();
      return { title: marker.title, text: body, chunks: chunksFor(body) };
    }).filter((c) => c.text.length > 50);
  }
  const bodyParts = paragraphs(text); const result = []; let current = '';
  for (const part of bodyParts) {
    if (!current || (current + '\n\n' + part).length <= 11000) current += (current ? '\n\n' : '') + part;
    else { result.push({ title: `Passage ${result.length + 1}`, text: current, chunks: chunksFor(current) }); current = part; }
  }
  if (current) result.push({ title: result.length ? `Passage ${result.length + 1}` : 'The beginning', text: current, chunks: chunksFor(current) });
  return result.length ? result : [{title:'The beginning', text, chunks:chunksFor(text)}];
}
async function parsePdf(file) {
  const pdfjs = await import(PDF_URL); pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.worker.min.mjs'; const pdf = await pdfjs.getDocument({data: await file.arrayBuffer()}).promise; let text = '';
  for (let i = 1; i <= pdf.numPages; i++) { const page = await pdf.getPage(i); const content = await page.getTextContent(); text += content.items.map((item) => item.str).join(' ') + '\n\n'; }
  return cleanText(text);
}
async function parseEpub(file) {
  const JSZip = (await import(ZIP_URL)).default; const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = new DOMParser().parseFromString(await zip.file('META-INF/container.xml').async('text'), 'application/xml');
  const rootfile = container.getElementsByTagName('rootfile')[0]?.getAttribute('full-path'); if (!rootfile) throw new Error('This EPUB has no readable package file.');
  const opf = new DOMParser().parseFromString(await zip.file(rootfile).async('text'), 'application/xml'); const base = rootfile.includes('/') ? rootfile.slice(0, rootfile.lastIndexOf('/') + 1) : '';
  const manifest = new Map(); for (const item of opf.getElementsByTagName('item')) manifest.set(item.getAttribute('id'), item.getAttribute('href'));
  const spine = [...opf.getElementsByTagName('itemref')].filter(item => item.getAttribute('linear') !== 'no').map((item) => manifest.get(item.getAttribute('idref'))).filter(Boolean); let text = '';
  for (const href of spine) {
    const path = (base + decodeURIComponent(href.split('#')[0])).replaceAll('\\', '/').split('/').reduce((parts, part) => part === '..' ? parts.slice(0, -1) : part && part !== '.' ? [...parts, part] : parts, []).join('/');
    const entry = zip.file(path); if (!entry) throw new Error('A chapter is missing from this EPUB.');
    const doc = new DOMParser().parseFromString(await entry.async('text'), 'text/html');
    doc.querySelectorAll('script, style, nav, head').forEach(node => node.remove());
    doc.querySelectorAll('p, div, h1, h2, h3, li, br').forEach(node => node.append('\n\n'));
    text += (doc.body?.textContent || '') + '\n\n';
  }
  return cleanText(text);
}
async function readBook(file, titleOverride = '') {
  const ext = file.name.split('.').pop().toLowerCase(); let text;
  if (ext === 'pdf') text = await parsePdf(file); else if (ext === 'epub') text = await parseEpub(file); else text = await file.text();
  if (text.length < 80) throw new Error('I could not find enough readable text in that file.');
  const title = titleOverride || file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  return { title: title.replace(/\b\w/g, (c) => c.toUpperCase()), text, chapters: buildChapters(text) };
}
function renderChapter() {
  const chapter = state.book.chapters[state.current]; if (!chapter) return;
  stopPlayback(); state.queue = chapter.chunks; state.queueIndex = -1; state.currentPassage = ''; state.words = [];
  els.bookTitle.textContent = state.book.title; els.bookMeta.textContent = `${state.book.chapters.length} ${state.book.chapters.length === 1 ? 'passage' : 'chapters'} · ${formatMinutes(state.book.text.length)} min read`;
  els.chapterTitle.textContent = chapter.title; els.chapterSubtitle.textContent = `${chapter.text.length.toLocaleString()} characters · ${chapter.chunks.length} listening ${chapter.chunks.length === 1 ? 'passage' : 'passages'}`;
  els.progressCopy.textContent = `${state.current + 1} / ${state.book.chapters.length}`; els.progressBar.style.width = `${((state.current + 1) / state.book.chapters.length) * 100}%`;
  els.list.innerHTML = state.book.chapters.map((item, i) => `<button class="chapter-item ${i === state.current ? 'active' : ''}" data-chapter="${i}" type="button"><span class="chapter-index">${String(i + 1).padStart(2, '0')}</span>${escapeHTML(item.title)}</button>`).join('');
  els.bookText.innerHTML = paragraphs(chapter.text).map((p, i) => `<p data-passage="${i}" tabindex="0">${escapeHTML(p)}</p>`).join('');
  els.voiceState.textContent = 'Ready when you are'; els.voiceDetail.textContent = state.voiceReady ? 'Local voice · click to begin' : 'Browser voice · click to begin';
  els.list.querySelectorAll('[data-chapter]').forEach((button) => button.addEventListener('click', () => { state.current = Number(button.dataset.chapter); renderChapter(); }));
  els.bookText.querySelectorAll('[data-passage]').forEach((paragraph) => { paragraph.addEventListener('click', () => playPassage(Number(paragraph.dataset.passage))); paragraph.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); playPassage(Number(paragraph.dataset.passage)); } }); });
}
function showReader(book) { state.book = book; state.current = 0; els.landing.hidden = true; els.reader.hidden = false; els.reset.hidden = false; renderChapter(); }
function setChip(mode, text) { els.chip.className = `engine-chip ${mode}`; els.chipText.textContent = text; }
async function checkVoice() {
  try { const response = await fetch('/api/narration/status'); const data = await response.json(); state.voiceReady = data.ready; state.voiceState = data.state; setChip(data.ready ? 'ready' : data.state === 'loading' ? 'loading' : 'fallback', data.ready ? 'local voice ready' : data.state === 'loading' ? 'warming local voice' : 'browser voice fallback'); }
  catch { state.voiceReady = false; state.voiceState = 'fallback'; setChip('fallback', 'browser voice fallback'); }
}
function renderWords(text, words) {
  if (!words?.length) return escapeHTML(text).replace(/\n\n/g, '</p><p>');
  let html = ''; let cursor = 0;
  for (const word of words) { const start = Math.max(cursor, word.textOffset); const end = Math.min(text.length, start + word.length); if (end <= start) continue; html += escapeHTML(text.slice(cursor, start)); html += `<span class="word" data-word="${words.indexOf(word)}">${escapeHTML(text.slice(start, end))}</span>`; cursor = end; }
  return html + escapeHTML(text.slice(cursor));
}
function highlightWord(time) {
  if (!state.words.length) return; let index = -1; for (let i = 0; i < state.words.length; i++) { if (time >= state.words[i].start && time < state.words[i].end) { index = i; break; } }
  els.bookText.querySelectorAll('.word.is-active').forEach((node) => node.classList.remove('is-active')); if (index >= 0) els.bookText.querySelector(`[data-word="${index}"]`)?.classList.add('is-active');
}
async function generateChunk(text) {
  const voice = els.voiceSelect.value; const response = await fetch('/api/narration/render', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({text, voice})});
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The local voice could not render this passage.'); return data;
}
async function playLocal() {
  const generation = ++state.generation; const chunk = state.queue[state.queueIndex]; if (!chunk) return;
  els.voiceState.textContent = state.queue.length > 1 ? `Preparing passage ${state.queueIndex + 1} of ${state.queue.length}` : 'Preparing your chapter'; els.voiceDetail.textContent = 'Kokoro · local neural voice';
  try {
    const rendered = await generateChunk(chunk); if (generation !== state.generation) return;
    state.words = rendered.words || []; state.currentPassage = chunk; els.bookText.innerHTML = `<p>${renderWords(chunk, state.words)}</p>`; els.audio.src = rendered.audioUrl; els.audio.currentTime = 0; await els.audio.play(); state.playing = true; updatePlayingUI();
  } catch (error) { state.playing = false; updatePlayingUI(); showToast(error.message); }
}
function playBrowser() {
  const chunk = state.queue[state.queueIndex]; if (!chunk || !('speechSynthesis' in window)) return showToast('This browser does not provide speech synthesis.');
  speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(chunk); utterance.rate = .94; utterance.onstart = () => { state.playing = true; updatePlayingUI(); }; utterance.onend = () => finishChunk(); utterance.onerror = () => { state.playing = false; updatePlayingUI(); };
  utterance.onboundary = (event) => { const start = event.charIndex || 0; els.bookText.innerHTML = `<p>${escapeHTML(chunk.slice(0, start))}<span class="word is-active">${escapeHTML(chunk.slice(start, start + (event.charLength || 3)) || ' ')}</span>${escapeHTML(chunk.slice(start + (event.charLength || 3)))}</p>`; };
  state.browserUtterance = utterance; speechSynthesis.speak(utterance);
}
function playPassage(index = 0) { const parts = paragraphs(state.book.chapters[state.current].text); state.queue = chunksFor(parts[index] || state.book.chapters[state.current].text); state.queueIndex = 0; state.generation++; if (els.voiceSelect.value === 'browser' || !state.voiceReady) playBrowser(); else playLocal(); }
function listenChapter() { state.queue = state.book.chapters[state.current].chunks; state.queueIndex = 0; state.generation++; if (els.voiceSelect.value === 'browser' || !state.voiceReady) playBrowser(); else playLocal(); }
function finishChunk() { if (state.queueIndex + 1 < state.queue.length) { state.queueIndex++; if (els.voiceSelect.value === 'browser' || !state.voiceReady) playBrowser(); else playLocal(); } else { state.playing = false; state.queueIndex = -1; els.voiceState.textContent = 'Chapter complete'; els.voiceDetail.textContent = 'Choose another passage to continue'; updatePlayingUI(); } }
function stopPlayback() { state.generation++; state.playing = false; speechSynthesis?.cancel(); els.audio.pause(); els.audio.removeAttribute('src'); updatePlayingUI(); }
function updatePlayingUI() { els.voiceOrb.classList.toggle('is-playing', state.playing); els.listen.classList.toggle('is-playing', state.playing); els.listen.querySelector('span:last-child').textContent = state.playing ? 'Pause listening' : 'Listen to chapter'; els.listen.querySelector('.play-icon').textContent = state.playing ? 'Ⅱ' : '▶'; }
async function loadSample() {
  els.sample.disabled = true; showToast('Loading a public-domain copy of Moby-Dick…', 2000);
  try {
    const response = await fetch('moby-dick.txt');
    const text = await response.text();
    // The Gutenberg edition has a contents list before the actual chapters.
    const beginning = text.lastIndexOf('\nCHAPTER 1. Loomings.', text.indexOf('Call me Ishmael.'));
    const file = new File([beginning >= 0 ? text.slice(beginning) : text], 'moby-dick.txt', { type: 'text/plain' });
    showReader(await readBook(file, 'Moby-Dick'));
  } catch (error) { showToast(error.message); } finally { els.sample.disabled = false; }
}
els.input.addEventListener('change', async () => { const file = els.input.files?.[0]; if (!file) return; try { showToast(`Reading ${file.name}…`, 3000); showReader(await readBook(file)); } catch (error) { showToast(error.message); } finally { els.input.value = ''; } });
els.sample.addEventListener('click', loadSample); els.reset.addEventListener('click', () => { stopPlayback(); els.reader.hidden = true; els.landing.hidden = false; els.reset.hidden = true; }); els.railImport.addEventListener('click', () => els.input.click()); els.listen.addEventListener('click', () => { if (state.playing) { if (els.voiceSelect.value === 'browser') speechSynthesis.pause(); else els.audio.pause(); state.playing = false; updatePlayingUI(); } else if (state.queueIndex >= 0) { if (els.voiceSelect.value === 'browser') speechSynthesis.resume(); else els.audio.play(); state.playing = true; updatePlayingUI(); } else listenChapter(); }); els.audio.addEventListener('timeupdate', () => highlightWord(els.audio.currentTime)); els.audio.addEventListener('ended', finishChunk); els.voiceSelect.addEventListener('change', () => { if (state.playing) stopPlayback(); });
async function exportBook(preview) {
  if (!state.book) return;
  const button = $(preview ? 'preview-btn' : 'export-btn');
  button.disabled = true;
  try {
    const voice = els.voiceSelect.value === 'browser' ? 'af_heart' : els.voiceSelect.value;
    const text = preview ? state.book.chapters[state.current].text : state.book.text;
    const response = await fetch('/api/books', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, title: state.book.title + (preview ? ' — Preview' : ''), voice, preview }) });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not start conversion.');
    showToast(job.state === 'complete' ? 'Your MP3 is ready below.' : 'Conversion saved. You can close this page while it runs.');
    await refreshJobs(); $('library').scrollIntoView({ behavior: 'smooth' });
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}
async function refreshJobs() {
  try {
    const response = await fetch('/api/books');
    if (!response.ok) return;
    const { jobs } = await response.json();
    const list = $('job-list');
    // Preserve audio playback while progress updates elsewhere in the list.
    for (const job of jobs) {
      let row = list.querySelector(`[data-job="${job.id}"]`);
      if (row && row.dataset.state === job.state && row.dataset.completed === String(job.completed)) continue;
      if (!row) { row = document.createElement('div'); row.className = 'job-row'; row.dataset.job = job.id; list.append(row); }
      row.dataset.state = job.state; row.dataset.completed = job.completed;
      const status = job.state === 'complete' ? `${job.duration < 60 ? Math.round(job.duration) + ' sec' : Math.round(job.duration / 60) + ' min'} · ${(job.length / 1048576).toFixed(1)} MB`
        : job.state === 'failed' ? job.error : `${job.state} · ${job.completed} / ${job.total} passages`;
      row.innerHTML = `<div><strong>${escapeHTML(job.title)}</strong><p>${escapeHTML(status || '')}</p></div>`;
      if (job.state === 'complete') {
        const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = job.audioUrl; row.append(audio);
        const link = document.createElement('a'); link.href = job.audioUrl; link.textContent = 'Download MP3'; link.className = 'secondary-button'; row.append(link);
      } else if (job.state === 'failed') {
        const retry = document.createElement('button'); retry.className = 'secondary-button'; retry.textContent = 'Retry saved job';
        retry.onclick = async () => { await fetch(`/api/books/${job.id}/retry`, { method: 'POST' }); await refreshJobs(); }; row.append(retry);
      } else {
        const progress = document.createElement('progress'); progress.max = job.total; progress.value = job.completed; row.append(progress);
      }
    }
    $('empty-library').hidden = jobs.length > 0;
  } catch { /* Progress polling resumes when the server is reachable. */ }
}
$('preview-btn').addEventListener('click', () => exportBook(true));
$('export-btn').addEventListener('click', () => exportBook(false));
$('copy-feed').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/feed'); const data = await response.json();
    if (!response.ok) throw new Error('Could not load your feed.');
    $('feed-url').value = data.feedUrl; $('feed-url').hidden = false;
    try { await navigator.clipboard.writeText(data.feedUrl); showToast('Private RSS URL copied. Add it by URL in your podcast app.'); }
    catch { $('feed-url').select(); showToast('Copy the private RSS URL shown below.'); }
  } catch (error) { showToast(error.message); }
});
checkVoice(); refreshJobs();
setInterval(refreshJobs, 3000);
setInterval(() => { if (!state.voiceReady) checkVoice(); }, 5000);
