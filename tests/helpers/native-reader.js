const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { browser, waitFor, extensionArgs } = require('./browser');
const { connect, target, resetExtension } = require('./unpacked');
function pdf() {
  let value = '%PDF-1.4\n';
  const offsets = [0];
  const text = 'BT /F1 18 Tf 40 720 Td (Readable PDF example.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
  ];
  objects.forEach((object, index) => {
    offsets.push(value.length);
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = value.length;
  value += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(value);
}
async function fixture(t) {
  const requests = [],
    slow = [];
  const wav = Buffer.alloc(44 + 48000 * 8);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/favicon.ico') return res.end();
    if (req.url === '/document.pdf') {
      res.setHeader('content-type', 'application/pdf');
      return res.end(pdf());
    }
    if (req.url === '/api/narration/render') {
      let raw = '';
      for await (const data of req) raw += data;
      const body = JSON.parse(raw);
      requests.push(body);
      if (body.text.includes('/slow')) {
        const pending = { closed: false };
        slow.push(pending);
        res.once('close', () => {
          pending.closed = true;
        });
        return;
      }
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify({
          audioUrl: '/api/narration/audio/' + 'a'.repeat(64) + '.wav',
          duration: 8,
          words: [{ start: 0, end: 8, textOffset: 0, length: body.text.split(/\s+/)[0].length }]
        })
      );
    }
    if (req.url.startsWith('/api/narration/audio/')) {
      res.setHeader('content-type', 'audio/wav');
      return res.end(wav);
    }
    if (req.url === '/api/narration/status') {
      res.setHeader('content-type', 'application/json');
      return res.end('{"ready":true}');
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<!doctype html><title>Playback ownership</title><main><p>Read this paragraph in ' +
        req.url +
        '.</p><p>A later paragraph.</p></main>'
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const extension = path.join(__dirname, '../../extension');
  const page = await browser(t, null, base + '/a', {
    network: true,
    args: extensionArgs()
  });
  if (!page) return null;
  const version = await (await fetch(`http://127.0.0.1:${page.port}/json/version`)).json();
  const cdp = await connect(t, version.webSocketDebuggerUrl, false);
  const id = crypto
    .createHash('sha256')
    .update(extension)
    .digest('hex')
    .slice(0, 32)
    .replace(/./g, (char) => String.fromCharCode(97 + parseInt(char, 16)));
  const worker = await target(t, page.port, (item) => item.url === `chrome-extension://${id}/background.js`);
  await readyDocument(worker, 'Boolean(globalThis.chrome?.storage?.local)');
  await resetExtension(worker);
  await worker.evaluate(`chrome.storage.local.set({sonoraServer:${JSON.stringify(base)}})`);
  const expression = (suffix, code) => `chrome.tabs.query({url:${JSON.stringify(base + suffix)}}).then(async tabs => {
    const results = await chrome.scripting.executeScript({target:{tabId:tabs[0].id},func:() => {
      const host=document.querySelector('#sonora-overlay-root');
      const panel=host && chrome.dom.openOrClosedShadowRoot(host);
      return (${code});
    }});return results[0].result;
  })`;
  const inTab = (suffix, code) => worker.evaluate(expression(suffix, code));
  const waitInTab = (suffix, code) => waitFor(worker, expression(suffix, code));
  async function open(suffix) {
    const tab = (await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] })).targetInfos.find(
      (item) => item.url === base + suffix
    );
    await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
    await waitInTab(suffix, 'Boolean(panel && window.__sonoraOverlay)');
    await inTab(suffix, 'window.__sonoraOverlay.whenIndexed.then(() => true)');
    // Observe native sources; leave their clocks and playback methods intact.
    await inTab(
      suffix,
      `(() => {
      window.nativeSources=[];
      const create=AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource=function(...args) {
        const source=create.apply(this,args), record={started:false,stopped:false,ended:false};
        nativeSources.push(record);
        const start=source.start, stop=source.stop;
        source.start=function(...values){record.started=true;return start.apply(this,values);};
        source.stop=function(...values){record.stopped=true;return stop.apply(this,values);};
        source.addEventListener('ended',()=>{record.ended=true;});return source;
      };
    })()`
    );
  }
  return { page, cdp, worker, base, requests, slow, open, inTab, waitInTab };
}
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert(predicate());
}
async function readyDocument(page, expression) {
  const deadline = Date.now() + 10000;
  do {
    try {
      if (await page.evaluate(expression)) return;
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error('Document did not become ready: ' + expression);
}
module.exports = { fixture, readyDocument, until };
