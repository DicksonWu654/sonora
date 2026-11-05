const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { Writable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const config = require('../tools/narration/config');
const cache = require('../tools/narration/cache');
const python = fs.existsSync(config.python) ? config.python : 'python3';
const moduleDirectory = path.join(__dirname, '../tools/narration');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cache-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function runPython(directory, body) {
  return execFileSync(python, ['-c', `import sys, os, json, math, struct, ast, wave
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from audio_cache import AudioCache, cache_limit
root = Path(sys.argv[2]); directory = root / 'audio'; store = AudioCache(directory)
def key(n): return format(n, '064x')
def pair(n, stamp=1):
 for suffix in ['.wav', '.json']:
  file=directory/(key(n)+suffix); file.write_bytes(b'x'*50); os.utime(file,(stamp,stamp))
${body}`, moduleDirectory, directory], { encoding: 'utf8' });
}

test('audio cache evicts least recently used pairs and respects the size cap', t => {
  runPython(fixture(t), `
pair(1,1);pair(2,2);pair(3,3)
store.max_bytes=200
result=store.prune(force=True)
assert result['bytes']==200 and result['removed']==2
assert not (directory/(key(1)+'.wav')).exists()
assert not (directory/(key(1)+'.json')).exists()
for n in [2,3]:
 assert all((directory/(key(n)+s)).exists() for s in ['.wav','.json'])
`);
});

test('cache hits in the actual worker reader refresh both halves and LRU recency', t => {
  runPython(fixture(t), `
for n in [1,2]:
 with wave.open(str(directory/(key(n)+'.wav')),'wb') as f:
  f.setnchannels(1);f.setsampwidth(2);f.setframerate(24000);f.writeframes(b'\\0'*480)
 (directory/(key(n)+'.json')).write_text(json.dumps({'voice':'af_heart','audioUrl':'/api/narration/audio/'+key(n)+'.wav','duration':.01,'words':[]}))
 for suffix in ['.wav','.json']:os.utime(directory/(key(n)+suffix),(n,n))
source=ast.parse((Path(sys.argv[1])/'worker.py').read_text())
functions=[node for node in source.body if isinstance(node,ast.FunctionDef) and node.name in ['utf16_len','_read_cache','read_cache']]
namespace={'CACHE_STORE':store,'os':os,'struct':struct,'json':json,'math':math}
exec(compile(ast.Module(body=functions,type_ignores=[]),'worker.py','exec'),namespace)
assert namespace['read_cache'](key(1),'Read this.','af_heart')['cached']
for suffix in ['.wav','.json']:
 info=(directory/(key(1)+suffix)).stat();assert info.st_atime>2 and info.st_mtime>2
store.max_bytes=sum((directory/(key(1)+s)).stat().st_size for s in ['.wav','.json'])
store.prune(force=True)
assert (directory/(key(1)+'.wav')).exists() and not (directory/(key(2)+'.wav')).exists()
`);
});

test('eviction cleans orphan halves and interrupted writes without following symlinks', t => {
  runPython(fixture(t), `
(directory/(key(1)+'.wav')).write_bytes(b'orphan')
(directory/(key(2)+'.json')).write_bytes(b'orphan')
(directory/(key(3)+'.wav.tmp')).write_bytes(b'interrupted')
(directory/(key(4)+'.random.json.tmp')).write_bytes(b'interrupted')
outside=root/'keep.wav';outside.write_bytes(b'keep');os.utime(outside,(1,1))
(directory/(key(5)+'.wav')).symlink_to(outside)
(directory/'nested').symlink_to(root,target_is_directory=True)
(directory/'keep.txt').write_text('unrelated')
store.max_bytes=0;store.prune(force=True)
for n in [1,2,3,4]:assert not any(p.name.startswith(key(n)) for p in directory.iterdir())
assert outside.stat().st_mtime==1 and outside.stat().st_atime==1 and outside.read_bytes()==b'keep'
assert (directory/'keep.txt').read_text()=='unrelated'
try:store.open(key(5),'.wav');raise AssertionError('symlink followed')
except OSError:pass
unsafe=root/'unsafe';unsafe.mkdir();(unsafe/'.leases').symlink_to(root,target_is_directory=True)
try:AudioCache(unsafe);raise AssertionError('lease directory symlink followed')
except OSError:pass
`);
});

test('active read and write leases protect pairs and orphan halves until release', t => {
  runPython(fixture(t), `
pair(1);pair(2)
store.max_bytes=0
with store.use(key(1)):
 (directory/(key(1)+'.wav.tmp')).write_bytes(b'writing')
 store.prune(force=True)
 assert all((directory/(key(1)+s)).exists() for s in ['.wav','.json','.wav.tmp'])
 assert not (directory/(key(2)+'.wav')).exists()
store.prune(force=True)
assert not any(p.name.startswith(key(1)) for p in directory.iterdir())
import subprocess, uuid
child=subprocess.Popen([sys.executable,'-c','pass']);child.wait()
stale=store.leases/('use.'+key(3)+'.'+str(child.pid)+'.'+uuid.uuid4().hex)
stale.touch();pair(3);store.prune(force=True)
assert not stale.exists() and not (directory/(key(3)+'.wav')).exists()
`);
});

test('post-write cache scans are throttled to one per minute and limits are configurable', t => {
  runPython(fixture(t), `
clock=[0];store=AudioCache(directory,max_bytes=100,clock=lambda:clock[0])
pair(1);store.prune(force=True);pair(2,2)
clock[0]=59;assert store.prune() is None
assert (directory/(key(1)+'.wav')).exists()
clock[0]=60;assert store.prune()['bytes']==100
assert not (directory/(key(1)+'.wav')).exists()
for value in ['0','-1','garbage','nan','inf','']:
 os.environ['SONORA_AUDIO_CACHE_MB']=value;assert cache_limit()==2048*1024*1024
os.environ['SONORA_AUDIO_CACHE_MB']='3.5';assert cache_limit()==int(3.5*1024*1024)
`);
});

test('Node leases protect entries from the Python evictor', async t => {
  const directory = fixture(t), audio = path.join(directory, 'audio'), key = '1'.repeat(64);
  fs.mkdirSync(audio);
  for (const suffix of ['.wav', '.json']) fs.writeFileSync(path.join(audio, key + suffix), 'fixture');
  const release = await cache.lease(audio, key);
  try {
    runPython(directory, 'store.max_bytes=0;store.prune(force=True)');
    assert(fs.existsSync(path.join(audio, key + '.wav')));
    assert(fs.existsSync(path.join(audio, key + '.json')));
  } finally { await release(); }
  runPython(directory, 'store.max_bytes=0;store.prune(force=True)');
  assert(!fs.existsSync(path.join(audio, key + '.wav')));
  assert(!fs.existsSync(path.join(audio, key + '.json')));
});

test('new cache readers wait for an eviction pass before touching files', async t => {
  const directory = fixture(t), folder = path.join(directory, '.leases'); fs.mkdirSync(folder);
  const marker = path.join(folder, `evict.${process.pid}.${'a'.repeat(32)}`); fs.writeFileSync(marker, '');
  let entered = false;
  const waiting = cache.lease(directory, '3'.repeat(64)).then(release => { entered = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(entered, false);
  fs.unlinkSync(marker); const release = await waiting; await release();
  assert.equal(entered, true);
});

function backend(directory) {
  const settings = { ...config, cacheDir: path.join(directory, 'audio'), python: path.join(directory, 'missing-python'), modelDir: directory };
  const context = { module: {exports: {}}, __dirname: moduleDirectory, process, Buffer, URL, setTimeout, clearTimeout, require(name) {
    if (name === './config') return settings;
    if (name === './cache') return cache;
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(moduleDirectory, 'backend.js'), 'utf8'), context);
  return context.module.exports.createNarrationBackend({authorize: () => true});
}
function audioPair(directory, key, bytes = 480) {
  const audio = path.join(directory, 'audio'); fs.mkdirSync(audio, {recursive: true});
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF');wav.writeUInt32LE(wav.length - 8, 4);wav.write('WAVEfmt ', 8);wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);wav.writeUInt16LE(1, 22);wav.writeUInt32LE(24000, 24);wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);wav.writeUInt16LE(16, 34);wav.write('data', 36);wav.writeUInt32LE(bytes, 40);
  fs.writeFileSync(path.join(audio, key + '.wav'), wav);
  fs.writeFileSync(path.join(audio, key + '.json'), JSON.stringify({audioUrl: '/api/narration/audio/' + key + '.wav', voice: 'af_heart', duration: bytes / 48000, words: []}));
  for (const suffix of ['.wav', '.json']) fs.utimesSync(path.join(audio, key + suffix), 1, 1);
}

test('backend cache hits refresh recency without starting the voice worker', async t => {
  const directory = fixture(t), text = 'Read this.', voice = 'af_heart';
  const key = crypto.createHash('sha256').update(JSON.stringify([config.engineVersion, config.revision, voice, text])).digest('hex');
  audioPair(directory, key);
  const narration = backend(directory); t.after(() => narration.close());
  assert.equal((await narration.generate(text, voice)).cached, true);
  for (const suffix of ['.wav', '.json']) {
    const info = fs.statSync(path.join(directory, 'audio', key + suffix));
    assert(info.atimeMs > 1000 && info.mtimeMs > 1000);
  }
});

test('an HTTP audio stream keeps its cache entry leased until its file closes', async t => {
  const directory = fixture(t), key = '2'.repeat(64);
  audioPair(directory, key, 128 * 1024);
  const narration = backend(directory); t.after(() => narration.close());
  let first;
  const received = new Promise(resolve => { first = resolve; });
  const response = new Writable({highWaterMark: 1, write(chunk, encoding, callback) { this.pending = callback; first(); }});
  response.writeHead = () => { response.headersSent = true; };
  await narration.handle({method: 'GET', headers: {}}, response, '/api/narration/audio/' + key + '.wav');
  await received;
  runPython(directory, 'store.max_bytes=0;store.prune(force=True)');
  assert(fs.existsSync(path.join(directory, 'audio', key + '.wav')));
  response.destroy(); response.pending?.();
  for (let at = 0; fs.readdirSync(path.join(directory, 'audio/.leases')).length && at < 100; at++) await new Promise(resolve => setTimeout(resolve, 5));
  runPython(directory, 'store.max_bytes=0;store.prune(force=True)');
  assert(!fs.existsSync(path.join(directory, 'audio', key + '.wav')));
});
