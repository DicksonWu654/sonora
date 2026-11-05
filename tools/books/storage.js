const fs = require('node:fs');
const path = require('node:path');

function sizeOf(directory) {
  let size = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) size += sizeOf(file);
    else if (entry.isFile()) size += fs.lstatSync(file).size;
  }
  return size;
}
function storageLimit() {
  const mb = Number(process.env.SONORA_BOOKS_MB || 2048);
  return Number.isFinite(mb) && mb > 0 ? Math.max(1, Math.floor(mb * 1024 * 1024)) : 2048 * 1024 * 1024;
}
class StorageBudget {
  constructor(directory, limit = storageLimit()) { this.directory = directory; this.limit = limit; this.refresh(); }
  refresh() { this.used = sizeOf(this.directory); this.checkedAt = Date.now(); }
  available() { if (Date.now() - this.checkedAt > 60000) this.refresh(); return this.limit - this.used; }
  error() { return Object.assign(new Error('Book storage quota reached. Remove saved books or increase SONORA_BOOKS_MB, then retry.'), { status: 507 }); }
  require(bytes) {
    if (bytes > this.available()) this.refresh();
    if (bytes > this.available()) throw this.error();
  }
}
module.exports = { StorageBudget, sizeOf };
