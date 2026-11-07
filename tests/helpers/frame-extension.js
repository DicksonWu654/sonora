const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { browser, waitFor, extensionArgs } = require('./browser');
const { connect, target, resetExtension } = require('./unpacked');

async function ready(page, expression) {
  const end = Date.now() + 15000;
  do {
    try {
      if (await page.evaluate(expression)) return;
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < end);
  throw Error('Document did not become ready: ' + expression);
}

async function fixture(t, html) {
  const urls = [],
    servers = [],
    renders = [];
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
  for (let index = 0; index < 4; index++) {
    const host = '127.0.0.' + (index + 1);
    const server = http.createServer(async (req, res) => {
      if (req.url === '/favicon.ico') return res.end();
      if (req.url === '/api/narration/status') {
        res.setHeader('content-type', 'application/json');
        return res.end('{"ready":true}');
      }
      if (req.url === '/api/narration/render') {
        let raw = '';
        for await (const data of req) raw += data;
        const body = JSON.parse(raw);
        renders.push(body);
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
      if (index === 1 && req.url === '/redirect') {
        res.writeHead(302, { location: urls[2] + '/loaded' });
        return res.end();
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        index === 0
          ? html(urls, req)
          : '<!doctype html><title>Embedded ' +
              index +
              '</title><main><p id="read">Readable embedded document ' +
              index +
              '.</p><p>Following prose.</p></main>'
      );
    });
    await new Promise((resolve) => server.listen(0, host, resolve));
    servers.push(server);
    urls.push(`http://${host}:${server.address().port}`);
  }
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  const extension = path.join(__dirname, '../../extension');
  const page = await browser(t, null, urls[0] + '/page', {
    network: true,
    args: extensionArgs()
  });
  if (!page) return null;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  });
  const version = await (await fetch(`http://127.0.0.1:${page.port}/json/version`)).json();
  const cdp = await connect(t, version.webSocketDebuggerUrl, false);
  const id = crypto
    .createHash('sha256')
    .update(extension)
    .digest('hex')
    .slice(0, 32)
    .replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  const worker = await target(t, page.port, (item) => item.url === `chrome-extension://${id}/background.js`);
  await ready(worker, 'Boolean(globalThis.chrome?.storage?.local)');
  await resetExtension(worker);
  await worker.evaluate(`chrome.storage.local.set({sonoraServer:${JSON.stringify(urls[0])}})`);
  const tabId = await worker.evaluate(
    `chrome.tabs.query({url:${JSON.stringify(urls[0] + '/*')}}).then(tabs=>tabs[0].id)`
  );
  const expression = (
    frameId,
    code
  ) => `chrome.scripting.executeScript({target:{tabId:${tabId},frameIds:[${frameId}]},func:()=>{
    const host=document.querySelector('#sonora-overlay-root'), panel=host&&chrome.dom.openOrClosedShadowRoot(host);
    return (${code});
  }}).then(results=>results[0].result)`;
  const inFrame = (frameId, code) => worker.evaluate(expression(frameId, code));
  const waitInFrame = (frameId, code) => waitFor(worker, expression(frameId, code));
  async function toolbar() {
    const address = await page.evaluate('location.href');
    const tab = (await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] })).targetInfos.find(
      (item) => item.url === address
    );
    await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
  }
  async function grant(pattern) {
    const opened = await cdp.send('Target.createTarget', { url: 'chrome://extensions/' });
    const settings = await target(t, page.port, (item) => item.id === opened.targetId);
    await ready(settings, 'Boolean(globalThis.chrome?.developerPrivate)');
    await settings.evaluate(
      `chrome.developerPrivate.addHostPermission(${JSON.stringify(id)},${JSON.stringify(pattern)})`
    );
    await cdp.send('Target.closeTarget', { targetId: opened.targetId });
    // Host access settings alone do not add an optional permission to the
    // extension's active set. Request it from an extension-page user gesture.
    const access = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${id}/frame-permission.html?` + new URLSearchParams({ origin: pattern })
    });
    const prompt = await target(t, page.port, (item) => item.id === access.targetId);
    await ready(
      prompt,
      `document.readyState==='complete' && location.pathname==='/frame-permission.html' && Boolean(globalThis.chrome?.permissions?.request)`
    );
    const response = await prompt.send('Runtime.evaluate', {
      expression: `chrome.permissions.request({origins:[${JSON.stringify(pattern)}]})`,
      userGesture: true,
      awaitPromise: true,
      returnByValue: true
    });
    if (response.exceptionDetails || response.result.value !== true)
      throw new Error('Could not grant fixture host: ' + JSON.stringify(response));
    await cdp.send('Target.closeTarget', { targetId: access.targetId });
    const top = (await cdp.send('Target.getTargets')).targetInfos.find(
      (item) => item.type === 'page' && item.url === urls[0] + '/page'
    );
    await cdp.send('Target.activateTarget', { targetId: top.targetId });
  }
  const loaded = () => worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
  const readers = () =>
    worker.evaluate(
      `chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},func:()=>Boolean(window.__sonoraOverlay)}).then(rows=>rows.filter(row=>row.result).map(row=>row.frameId))`
    );
  async function sources(frameId) {
    await inFrame(
      frameId,
      `(() => {
      window.nativeSources=[];const create=AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource=function(...args) {
        const source=create.apply(this,args), state={started:false,stopped:false,ended:false};nativeSources.push(state);
        const start=source.start,stop=source.stop;
        source.start=function(...args){state.started=true;return start.apply(this,args);};
        source.stop=function(...args){state.stopped=true;return stop.apply(this,args);};
        source.addEventListener('ended',()=>{state.ended=true;});return source;
      };
    })()`
    );
  }
  async function play(frameId) {
    await inFrame(frameId, 'window.__sonoraOverlay.whenIndexed.then(()=>true)');
    await sources(frameId);
    await inFrame(frameId, `document.querySelector('p').click()`);
    await waitInFrame(frameId, `nativeSources.some(source=>source.started&&!source.stopped&&!source.ended)`);
  }
  return {
    page,
    worker,
    cdp,
    id,
    tabId,
    urls,
    renders,
    toolbar,
    grant,
    loaded,
    readers,
    inFrame,
    waitInFrame,
    play,
    ready
  };
}
module.exports = { fixture, ready };
