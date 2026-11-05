// node tools/profile-scroll.cjs <label>; optional SONORA_BUILD, SCROLL_MODES, SONORA_PLAYWRIGHT.
// Uses a real unpacked MV3 toolbar action, synthetic site traffic, WAVs and word timings.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const playwright =
  process.env.SONORA_PLAYWRIGHT ||
  fs
    .readdirSync(path.join(os.homedir(), '.npm/_npx'))
    .map((name) => path.join(os.homedir(), '.npm/_npx', name, 'node_modules/playwright'))
    .find((name) => fs.existsSync(name));
if (!playwright) throw new Error('Install Playwright or set SONORA_PLAYWRIGHT to its module directory.');
const { chromium } = require(playwright);
const repo = path.resolve(__dirname, '..'),
  build = process.env.SONORA_BUILD || repo,
  label = process.argv[2] || 'before';
const out = path.join(repo, 'output/scroll', label);
fs.mkdirSync(out, { recursive: true });
const { heavyChatHtml } = require(path.join(repo, 'tests/helpers/chatgpt'));
const chromiumPath = () =>
  fs
    .readdirSync(path.join(os.homedir(), '.cache/ms-playwright'))
    .filter((n) => /^chromium-/.test(n))
    .sort()
    .reverse()
    .flatMap((n) =>
      ['chrome-linux64/chrome', 'chrome-linux/chrome'].map((p) => path.join(os.homedir(), '.cache/ms-playwright', n, p))
    )
    .find((p) => fs.existsSync(p));
const fixture = heavyChatHtml();
fs.writeFileSync(path.join(repo, 'output/scroll/heavy-chat.html'), fixture);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wav = Buffer.alloc(44 + 96000 * 2);
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
for (let at = 44; at < wav.length; at += 2)
  wav.writeInt16LE(Math.round(Math.sin((at / 48000) * 440 * Math.PI * 2) * 800), at);
let renderCount = 0;
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/status')) res.end(JSON.stringify({ ready: true }));
  else if (req.url.endsWith('/render')) {
    let body = '';
    for await (const c of req) body += c;
    const data = JSON.parse(body);
    renderCount++;
    const words = [...data.text.matchAll(/\S+/g)].map((m, i, all) => ({
      start: (4 * i) / all.length,
      end: (4 * (i + 1)) / all.length,
      textOffset: m.index,
      length: m[0].length
    }));
    res.end(JSON.stringify({ audioUrl: '/api/narration/audio/' + 'a'.repeat(64) + '.wav', words }));
  } else if (req.url.includes('/audio/')) {
    res.setHeader('Content-Type', 'audio/wav');
    res.end(wav);
  } else {
    res.writeHead(404);
    res.end();
  }
});
function instrument() {
  globalThis.__scrollCosts = {
    observerCalls: 0,
    observerMs: 0,
    refreshes: 0,
    batches: 0,
    visibleChecks: 0,
    extractions: 0,
    marks: 0,
    geometry: 0,
    wordUpdates: 0,
    wordMs: 0
  };
  const Observer = MutationObserver;
  globalThis.MutationObserver = class extends Observer {
    constructor(callback) {
      super((...args) => {
        const at = performance.now();
        __scrollCosts.observerCalls++;
        try {
          return callback(...args);
        } finally {
          __scrollCosts.observerMs += performance.now() - at;
        }
      });
    }
  };
  const timeout = setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    timeout(
      (...values) => {
        if (callback.name === 'refreshBlocks') __scrollCosts.refreshes++;
        if (callback.name === 'batch') __scrollCosts.batches++;
        return callback(...values);
      },
      delay,
      ...args
    );
  const idle = requestIdleCallback;
  globalThis.requestIdleCallback = (callback, options) =>
    idle((deadline) => {
      if (callback.name === 'refreshBlocks') __scrollCosts.refreshes++;
      return callback(deadline);
    }, options);
  for (const name of ['visibleBlock', 'readableText']) {
    const fn = SonoraPassages[name];
    SonoraPassages[name] = (...args) => {
      __scrollCosts[name === 'visibleBlock' ? 'visibleChecks' : 'extractions']++;
      return fn(...args);
    };
  }
  const mark = DOMTokenList.prototype.add;
  DOMTokenList.prototype.add = function (...args) {
    __scrollCosts.marks++;
    return mark.apply(this, args);
  };
  for (const [obj, name] of [
    [Element.prototype, 'getBoundingClientRect'],
    [Element.prototype, 'getClientRects'],
    [Range.prototype, 'getClientRects']
  ]) {
    const fn = obj[name];
    obj[name] = function (...args) {
      __scrollCosts.geometry++;
      return fn.apply(this, args);
    };
  }
  const tracker = SonoraWords.createTracker;
  SonoraWords.createTracker = (...args) => {
    const value = tracker(...args),
      update = value.update;
    value.update = (...args) => {
      const at = performance.now();
      __scrollCosts.wordUpdates++;
      try {
        return update(...args);
      } finally {
        __scrollCosts.wordMs += performance.now() - at;
      }
    };
    return value;
  };
}
async function isolated(s, expression) {
  const r = await s.cdp.send('Runtime.evaluate', {
    expression,
    contextId: s.world,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function traceStop(cdp, file) {
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  let body = '';
  for (;;) {
    const r = await cdp.send('IO.read', { handle: stream });
    body += r.data;
    if (r.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  fs.writeFileSync(file, body);
}
function stats(trace, seconds) {
  const data = JSON.parse(fs.readFileSync(trace)).traceEvents;
  const main = new Set(
    data.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => e.tid)
  );
  const events = data.filter((e) => main.has(e.tid) && e.ph === 'X');
  const sum = (name) => events.filter((e) => e.name === name).reduce((a, e) => a + (e.dur || 0) / 1000, 0);
  const style = events.filter((e) => e.name === 'UpdateLayoutTree');
  return {
    styleMs: sum('UpdateLayoutTree'),
    styleMsPerSecond: sum('UpdateLayoutTree') / seconds,
    layoutMs: sum('Layout'),
    paintMs: sum('Paint'),
    styleAffectedElements: style.reduce((a, e) => a + (e.args?.elementCount || e.args?.data?.elementCount || 0), 0),
    styleMaxAffectedElements: Math.max(0, ...style.map((e) => e.args?.elementCount || e.args?.data?.elementCount || 0)),
    mainTaskMaxMs: Math.max(0, ...events.filter((e) => e.name === 'RunTask').map((e) => (e.dur || 0) / 1000)),
    traceDroppedFrames: data.filter((e) => e.name === 'DroppedFrame').length
  };
}
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const results = {
    label,
    version: JSON.parse(fs.readFileSync(path.join(build, 'extension/manifest.json'))).version,
    fixture: { turns: 2200, bytes: Buffer.byteLength(fixture) },
    conditions: {}
  };
  try {
    for (const mode of (process.env.SCROLL_MODES || 'A,B,C,D').split(',')) {
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-scroll-' + mode + '-'));
      let context;
      try {
        context = await chromium.launchPersistentContext(profile, {
          executablePath: chromiumPath(),
          headless: true,
          viewport: { width: 1440, height: 1000 },
          args: [
            '--no-sandbox',
            '--autoplay-policy=no-user-gesture-required',
            '--enable-unsafe-extension-debugging',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            ...(mode === 'A'
              ? []
              : [`--disable-extensions-except=${build}/extension`, `--load-extension=${build}/extension`])
          ]
        });
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        await page.route('https://chatgpt.com/**', (r) => r.fulfill({ contentType: 'text/html', body: fixture }));
        await page.goto('https://chatgpt.com/c/heavy-scroll');
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Runtime.enable');
        const s = { cdp };
        let worker;
        if (mode !== 'A') {
          worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
          await worker.evaluate(
            async (base) => chrome.storage.local.set({ sonoraServer: base, sonoraSpeed: 1 }),
            `http://127.0.0.1:${server.address().port}`
          );
        }
        if (['C', 'D'].includes(mode)) {
          const id = new URL(worker.url()).hostname;
          cdp.on('Runtime.executionContextCreated', ({ context }) => {
            if (context.origin === `chrome-extension://${id}` || context.name === id) s.world = context.id;
          });
          await cdp.send('Debugger.enable');
          const lines = fs.readFileSync(path.join(build, 'extension/overlay.js'), 'utf8').split('\n');
          await cdp.send('Debugger.setBreakpointByUrl', {
            lineNumber: lines.findIndex((l) => l.includes('const wordTracker =')),
            url: `chrome-extension://${id}/overlay.js`,
            condition: `((${instrument.toString()})(),false)`
          });
          const bcdp = await context.browser().newBrowserCDPSession();
          const tab = (
            await bcdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] })
          ).targetInfos.find((t) => t.url.includes('/heavy-scroll'));
          const at = performance.now();
          await bcdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
          await page.waitForSelector('#sonora-overlay-root', { state: 'attached' });
          await isolated(s, 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
          s.openMs = performance.now() - at;
          await cdp.send('Debugger.disable');
          // Include discovery overlap with real hover/background traffic, as daily use does.
          if (mode === 'D') {
            await page.locator('#text-0').click({ position: { x: 15, y: 12 } });
            for (let i = 0; i < 200; i++) {
              if (
                (
                  await isolated(
                    s,
                    `chrome.dom.openOrClosedShadowRoot(document.querySelector('#sonora-overlay-root')).querySelector('.status span').textContent`
                  )
                ).startsWith('Playing')
              )
                break;
              await sleep(50);
            }
          }
        }
        await sleep(1500);
        console.log(label, mode, 'ready', s.openMs || 0);
        await cdp.send('Performance.enable');
        await cdp.send('Profiler.enable');
        const phases = {},
          cpuProfiles = [];
        for (const phase of ['scroll', 'hover']) {
          await cdp.send('Tracing.start', {
            categories: 'devtools.timeline,disabled-by-default-devtools.timeline,cc,benchmark',
            transferMode: 'ReturnAsStream'
          });
          await cdp.send('Profiler.start');
          await page.evaluate(() => {
            window.measure = { frames: [], longtasks: [], last: performance.now() };
            window.measuring = true;
            window.po = new PerformanceObserver((list) => {
              for (const e of list.getEntries())
                if (measuring) measure.longtasks.push({ start: e.startTime, duration: e.duration });
            });
            po.observe({ type: 'longtask' });
            function frame(now) {
              if (!measuring) return;
              measure.frames.push(now - measure.last);
              measure.last = now;
              requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
          });
          const initial = await page.evaluate(() => ({
            height: document.documentElement.scrollHeight,
            y: scrollY,
            stats: { ...siteStats }
          }));
          const previous = ['C', 'D'].includes(mode) ? await isolated(s, '({...__scrollCosts})') : null;
          const start = performance.now();
          const steps = phase === 'scroll' ? 600 : 100,
            interval = phase === 'scroll' ? 35 : 35;
          for (let step = 0; step < steps; step++) {
            if (phase === 'scroll')
              await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: 600,
                y: 450,
                deltaX: 0,
                deltaY: (initial.height * 1.4) / steps
              });
            if (step % 2 === 0)
              await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: 380 + (step % 8) * 54,
                y: 130 + (step % 11) * 51
              });
            await sleep(Math.max(1, start + (step + 1) * interval - performance.now()));
          }
          await sleep(150);
          const seconds = (performance.now() - start) / 1000;
          const measurement = await page.evaluate(() => {
            measuring = false;
            po.disconnect();
            return {
              ...measure,
              endY: scrollY,
              height: document.documentElement.scrollHeight,
              siteStats,
              now: performance.now()
            };
          });
          const frames = measurement.frames.filter((dt) => dt > 1).sort((a, b) => a - b),
            slots = frames.reduce((a, dt) => a + Math.max(1, Math.round(dt / (1000 / 60))), 0),
            dropped = slots - frames.length;
          const costs = ['C', 'D'].includes(mode) ? await isolated(s, '({...__scrollCosts})') : null;
          if (costs) for (const k in costs) costs[k] -= previous[k];
          // Stop the live measurements BEFORE exporting a potentially huge trace.
          // Otherwise resumed idle indexing is misreported as wheel/hover work.
          const { profile: cpu } = await cdp.send('Profiler.stop');
          cpuProfiles.push(cpu);
          fs.writeFileSync(path.join(out, mode + '-' + phase + '.cpuprofile'), JSON.stringify(cpu));
          await traceStop(cdp, path.join(out, mode + '-' + phase + '.trace.json'));
          fs.writeFileSync(path.join(out, mode + '-' + phase + '.frames.json'), JSON.stringify(measurement.frames));
          phases[phase] = {
            seconds,
            frameP95Ms: frames[Math.floor(frames.length * 0.95)],
            frameMaxMs: Math.max(...frames),
            frames: frames.length,
            droppedFrames: dropped,
            droppedPercent: (100 * dropped) / slots,
            longTasks: measurement.longtasks,
            trace: stats(path.join(out, mode + '-' + phase + '.trace.json'), seconds),
            costs,
            initial,
            end: { y: measurement.endY, height: measurement.height, siteStats: measurement.siteStats }
          };
          console.log(
            label,
            mode,
            phase,
            JSON.stringify({
              p95: phases[phase].frameP95Ms,
              drop: phases[phase].droppedPercent,
              style: phases[phase].trace.styleMsPerSecond,
              costs
            })
          );
        }
        fs.writeFileSync(path.join(out, mode + '.cpuprofile'), JSON.stringify(cpuProfiles));
        results.conditions[mode] = {
          openMs: s.openMs,
          phases,
          consoleErrors: errors,
          metrics: (await cdp.send('Performance.getMetrics')).metrics,
          renderCount,
          status: ['C', 'D'].includes(mode)
            ? await isolated(
                s,
                `chrome.dom.openOrClosedShadowRoot(document.querySelector('#sonora-overlay-root')).querySelector('.status span').textContent`
              )
            : null
        };
        results.browser = context.browser().version();
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
      } finally {
        await context?.close();
        fs.rmSync(profile, { recursive: true, force: true });
      }
    }
    console.log(label, 'DONE');
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
