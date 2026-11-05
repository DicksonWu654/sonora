const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function lease(directory, key) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid audio cache key.');
  const folder = path.join(directory, '.leases');
  await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
  if (!(await fs.promises.lstat(folder)).isDirectory()) throw new Error('Invalid audio cache lease directory.');
  async function maintenance() {
    for (const name of await fs.promises.readdir(folder)) {
      const match = /^evict\.([1-9][0-9]*)\.[a-f0-9]{32}$/.exec(name);
      if (!match) continue;
      try { process.kill(Number(match[1]), 0); return true; }
      catch (error) { if (error.code !== 'ESRCH') return true; }
      await fs.promises.unlink(path.join(folder, name)).catch(() => {});
    }
    return false;
  }
  const deadline = Date.now() + 30000;
  for (;;) {
    if (!await maintenance()) {
      const claim = path.join(folder, `use.${key}.${process.pid}.${crypto.randomBytes(16).toString('hex')}`);
      const file = await fs.promises.open(claim, 'wx', 0o600);
      await file.close();
      const release = () => fs.promises.unlink(claim).catch(() => {});
      try { if (!await maintenance()) return release; }
      catch (error) { await release(); throw error; }
      await release();
    }
    if (Date.now() > deadline) throw new Error('Audio cache maintenance did not finish.');
    await pause(10);
  }
}
async function openEntry(directory, key, suffix) {
  if (!/^[a-f0-9]{64}$/.test(key) || !['.wav', '.json'].includes(suffix)) throw new Error('Invalid audio cache path.');
  const file = path.join(directory, key + suffix);
  if (!(await fs.promises.lstat(file)).isFile()) throw new Error('Invalid audio cache file.');
  return fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
}
async function touch(directory, key) {
  const now = new Date();
  for (const suffix of ['.wav', '.json']) {
    const file = await openEntry(directory, key, suffix);
    try { await file.utimes(now, now); } finally { await file.close(); }
  }
}
module.exports = { lease, openEntry, touch };
