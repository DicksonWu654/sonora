const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { cleanText, chunksFor } = require('../../public/text');
const voiceConfig = require('../narration/config');
const audioCache = require('../narration/cache');
const { StorageBudget, sizeOf } = require('./storage');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', data => { error = (error + data).slice(-1500); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Audio encoding failed (${code}): ${error}`)));
  });
}
function createBookJobs({ directory, narration, ffmpeg, cacheDirectory = voiceConfig.cacheDir, maxBytes }) {
  const jobs = new Map();
  let running = false, closed = false;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let metadataReserve = 65536;
  for (const id of fs.readdirSync(directory)) {
    if (!/^[a-f0-9]{24}$/.test(id)) continue;
    try {
      if (!fs.lstatSync(path.join(directory, id)).isDirectory() || !fs.lstatSync(path.join(directory, id, 'job.json')).isFile()) continue;
      const job = JSON.parse(fs.readFileSync(path.join(directory, id, 'job.json'), 'utf8'));
      if (job.id !== id) continue;
      const folder = path.join(directory, id);
      for (const name of ['concat.txt', 'book.tmp.mp3']) fs.rmSync(path.join(folder, name), { force: true });
      if (job.state === 'complete' && fs.existsSync(path.join(folder, 'book.mp3'))) fs.rmSync(path.join(folder, 'parts'), { recursive: true, force: true });
      metadataReserve = Math.max(metadataReserve, fs.statSync(path.join(folder, 'job.json')).size + 65536);
      if (['queued', 'rendering', 'encoding'].includes(job.state)) job.state = 'queued';
      if (job.state === 'complete' && !fs.existsSync(path.join(directory, id, 'book.mp3'))) job.state = 'queued';
      jobs.set(id, job);
    } catch { console.error('Could not read a saved book checkpoint:', id); }
  }
  const budget = new StorageBudget(directory, maxBytes);
  const save = (job, recovering = false) => {
    job.updatedAt = new Date().toISOString();
    const file = path.join(directory, job.id, 'job.json');
    const bytes = Buffer.byteLength(JSON.stringify(job, null, 2));
    const previous = fs.existsSync(file) ? fs.statSync(file).size : 0;
    metadataReserve = Math.max(metadataReserve, bytes + 65536);
    if (!recovering) budget.require(bytes);
    atomicJson(file, job);
    budget.used += bytes - previous;
  };
  function summary(job) {
    return { id: job.id, title: job.title, voice: job.voice, state: job.state, completed: job.completed,
      total: job.chunks.length, duration: job.duration || 0, length: job.length || 0, error: job.error || null,
      preview: job.preview, publishedAt: job.publishedAt, createdAt: job.createdAt,
      audioUrl: job.state === 'complete' ? `/api/books/${job.id}/audio` : null };
  }
  async function waitReady() {
    for (let i = 0; i < 150; i++) {
      if (closed) throw new Error('Server stopping; progress has been saved.');
      const status = narration.status();
      if (status.ready) return;
      if (!status.installed) throw new Error('Install Kokoro with npm run voice:setup, then retry this saved job.');
      await pause(1000);
    }
    throw new Error('Kokoro did not become ready; retry the saved job.');
  }
  async function renderPart(text, voice, folder, depth = 0) {
    if (!/[\p{L}\p{N}]/u.test(text)) return [];
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (closed) throw new Error('Server stopping; progress has been saved.');
      try {
        await waitReady();
        const audio = await narration.generate(text, voice);
        const key = /^\/api\/narration\/audio\/([a-f0-9]{64})\.wav$/.exec(audio.audioUrl)?.[1];
        if (!key || !(audio.duration > 0)) throw new Error('The voice returned invalid audio.');
        const release = await audioCache.lease(cacheDirectory, key);
        const temporary = path.join(folder, key + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
        let ownedFolder = false;
        try {
          const source = path.join(cacheDirectory, key + '.wav');
          const info = fs.lstatSync(source);
          if (!info.isFile()) throw new Error('The voice returned an invalid audio file.');
          budget.require(info.size + metadataReserve);
          fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
          if (!fs.lstatSync(folder).isDirectory()) throw new Error('Book parts must use a regular directory.');
          ownedFolder = true;
          const file = path.join(folder, key + '.wav');
          const previous = fs.existsSync(file) ? fs.lstatSync(file).size : 0;
          try { fs.linkSync(source, temporary); }
          catch (error) { if (error.code !== 'EXDEV') throw error; fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL); }
          fs.renameSync(temporary, file);
          budget.used += info.size - previous;
          return [{ file, duration: audio.duration }];
        } finally { if (ownedFolder) fs.rmSync(temporary, { force: true }); await release(); }
      } catch (error) {
        last = error;
        if (error.status === 507) throw error;
        if (error.status === 422) break;
        if (attempt < 2) await pause(1000 * (attempt + 1));
      }
    }
    if (last.status === 422 && text.length > 160 && depth < 5) {
      const subparts = chunksFor(text, Math.max(80, Math.floor(text.length / 2)));
      const result = [];
      for (const subpart of subparts) result.push(...await renderPart(subpart, voice, folder, depth + 1));
      return result;
    }
    throw last;
  }
  async function processJob(job) {
    const folder = path.join(directory, job.id), partFolder = path.join(folder, 'parts');
    job.state = 'rendering'; job.error = null; save(job);
    for (let index = 0; index < job.chunks.length; index++) {
      if (closed) return;
      // Job-owned WAV links survive render-cache eviction and server restarts.
      // Revalidate them before resuming; corrupt/missing parts are regenerated.
      const previous = job.parts[index];
      const reusable = Array.isArray(previous) && previous.length && previous.every(part => {
        if (typeof part?.file !== 'string' || !Number.isFinite(part.duration) || part.duration <= 0 || path.dirname(part.file) !== partFolder || !/^[a-f0-9]{64}\.wav$/.test(path.basename(part.file))) return false;
        let file;
        try {
          if (!fs.lstatSync(part.file).isFile()) return false;
          file = fs.openSync(part.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          const header = Buffer.alloc(44), size = fs.fstatSync(file).size;
          return fs.readSync(file, header, 0, 44, 0) === 44 && header.toString('ascii', 0, 4) === 'RIFF'
            && header.toString('ascii', 8, 16) === 'WAVEfmt ' && header.toString('ascii', 36, 40) === 'data'
            && header.readUInt32LE(4) === size - 8 && header.readUInt32LE(40) === size - 44
            && header.readUInt16LE(20) === 1 && header.readUInt16LE(22) === 1 && header.readUInt32LE(24) === 24000 && header.readUInt16LE(34) === 16
            && Math.abs((size - 44) / 48000 - part.duration) < .001;
        } catch { return false; } finally { if (file !== undefined) fs.closeSync(file); }
      });
      const rendered = reusable ? previous : await renderPart(job.chunks[index], job.voice, partFolder);
      job.parts[index] = rendered;
      job.completed = Math.max(job.completed, index + 1);
      save(job);
    }
    const parts = job.parts.flat();
    if (!parts.length) throw new Error('No spoken audio was generated.');
    job.state = 'encoding'; save(job);
    const list = path.join(folder, 'concat.txt');
    const contents = parts.map(part => `file '${part.file.replace(/'/g, "'\\''")}'`).join('\n');
    budget.require(Buffer.byteLength(contents) + metadataReserve);
    fs.writeFileSync(list, contents, { mode: 0o600 });
    budget.used += Buffer.byteLength(contents);
    const temporary = path.join(folder, 'book.tmp.mp3');
    const available = Math.floor(budget.available() - metadataReserve - 65536);
    try {
      if (available <= 16384) throw budget.error();
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '96k', '-ar', '24000', '-ac', '1',
      '-fs', String(available), '-metadata', `title=${job.title}`, '-metadata', 'artist=Sonora (Kokoro synthetic narration)', temporary]);
      const size = fs.statSync(temporary).size;
      if (size >= available - 16384) throw budget.error();
      budget.refresh();
      budget.require(metadataReserve);
      fs.chmodSync(temporary, 0o600);
      const final = path.join(folder, 'book.mp3');
      const oldSize = fs.existsSync(final) ? fs.statSync(final).size : 0;
      fs.renameSync(temporary, final);
      budget.used -= oldSize;
    } finally {
      fs.rmSync(temporary, { force: true });
      fs.rmSync(list, { force: true });
      budget.refresh();
    }
    job.duration = parts.reduce((sum, part) => sum + part.duration, 0);
    job.length = fs.statSync(path.join(folder, 'book.mp3')).size;
    job.publishedAt = job.publishedAt || new Date().toISOString();
    job.state = 'complete'; job.error = null; save(job);
    const partBytes = fs.existsSync(partFolder) ? sizeOf(partFolder) : 0;
    fs.rmSync(partFolder, { recursive: true, force: true });
    budget.used -= partBytes;
  }
  async function pump() {
    if (running || closed) return;
    running = true;
    try {
      for (;;) {
        const job = [...jobs.values()].find(item => item.state === 'queued');
        if (!job || closed) break;
        try { await processJob(job); }
        catch (error) { job.state = closed ? 'queued' : 'failed'; job.error = error.message; save(job, true); }
      }
    } finally { running = false; }
  }
  setImmediate(pump);
  return {
    create(input) {
      if (!input || typeof input.text !== 'string' || !input.text.trim()) throw Object.assign(new Error('Book text is required.'), { status: 400 });
      if (input.text.length > 12000000) throw Object.assign(new Error('Book text exceeds the 12 million character limit.'), { status: 413 });
      const voice = input.voice || 'af_heart';
      if (!voiceConfig.voices.some(item => item.id === voice)) throw Object.assign(new Error('Unknown narration voice.'), { status: 400 });
      let text = cleanText(input.text);
      if (input.preview === true) text = chunksFor(text, 280)[0] || '';
      const chunks = chunksFor(text).filter(piece => /[\p{L}\p{N}]/u.test(piece));
      if (!chunks.length) throw Object.assign(new Error('No readable words were found.'), { status: 400 });
      const title = typeof input.title === 'string' ? cleanText(input.title).slice(0, 180) : 'Untitled book';
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([voiceConfig.engineVersion, voice, title, text])).digest('hex');
      const existing = [...jobs.values()].find(job => job.fingerprint === fingerprint);
      if (existing) return summary(existing);
      const job = { id: crypto.randomBytes(12).toString('hex'), fingerprint, title: title || 'Untitled book', voice,
        chunks, parts: [], completed: 0, state: 'queued', preview: input.preview === true, createdAt: new Date().toISOString() };
      budget.refresh();
      budget.require(2 * Buffer.byteLength(JSON.stringify(job, null, 2)) + metadataReserve);
      save(job); jobs.set(job.id, job); setImmediate(pump);
      return summary(job);
    },
    list() { return [...jobs.values()].map(summary).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    get(id) { const job = jobs.get(id); return job ? summary(job) : null; },
    retry(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (job.state === 'failed') { job.state = 'queued'; job.error = null; save(job); setImmediate(pump); }
      return summary(job);
    },
    audioFile(id) { return path.join(directory, id, 'book.mp3'); },
    close() { closed = true; }
  };
}
module.exports = { createBookJobs, atomicJson };
