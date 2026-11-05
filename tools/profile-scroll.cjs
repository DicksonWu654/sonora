// Interleaved runner adapted from the independent /tmp/measure-runner.cjs.
// node tools/profile-scroll.cjs <output-label>; SCROLL_REPS >= 5, optional SCROLL_CONDITIONS.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const modulePath =
  process.env.SONORA_PLAYWRIGHT ||
  fs
    .readdirSync(path.join(os.homedir(), '.npm/_npx'))
    .map((name) => path.join(os.homedir(), '.npm/_npx', name, 'node_modules/playwright'))
    .find((name) => fs.existsSync(name));
if (!modulePath) throw new Error('Install Playwright or set SONORA_PLAYWRIGHT to its module directory.');
const { chromium } = require(modulePath);
const repo = path.resolve(__dirname, '..');
const out = path.join(repo, 'output/scroll', process.argv[2] || 'interleaved');
fs.mkdirSync(out, { recursive: true });
const builds = {};
const sequence = (process.env.SCROLL_CONDITIONS || 'A,C048,Cnone,Cturn,Ccoarse,D048,Dnone,Dturn,Dcoarse').split(',');
const repetitions = Number(process.env.SCROLL_REPS || 5);
if (!Number.isInteger(repetitions) || repetitions < 5)
  throw new Error('Comparisons require at least five interleaved repetitions.');
let activeContext = null,
  interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
  activeContext?.close().catch(() => {});
});
process.on('SIGTERM', () => {
  interrupted = true;
  activeContext?.close().catch(() => {});
});
const { heavyChatHtml } = require(path.join(repo, 'tests/helpers/chatgpt'));
const fixture = heavyChatHtml();
const fixtureHash = crypto.createHash('sha256').update(fixture).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function buildHash(build) {
  return hash(
    fs
      .readdirSync(path.join(build, 'extension'))
      .sort()
      .filter((name) => /\.(js|css|json|html)$/.test(name))
      .map((name) => name + fs.readFileSync(path.join(build, 'extension', name)))
      .join('')
  );
}
function snapshotBuilds() {
  const destination = path.join(out, 'builds');
  fs.mkdirSync(destination, { recursive: true });
  builds['048'] = path.join(destination, '048');
  if (!fs.existsSync(builds['048'])) {
    fs.mkdirSync(builds['048']);
    execFileSync('tar', ['-x', '-C', builds['048']], {
      input: execFileSync('git', ['archive', process.env.SCROLL_BASELINE || '18cc151', 'extension', 'package.json'], {
        cwd: repo
      })
    });
  }
  for (const mode of ['none', 'turn', 'coarse']) {
    builds[mode] = path.join(destination, mode);
    const source = fs.readFileSync(path.join(repo, 'extension/overlay.js'), 'utf8');
    const modified = source.replace(/const CHATGPT_CONTAINMENT = '[^']+';/, `const CHATGPT_CONTAINMENT = '${mode}';`);
    if (modified === source && !source.includes(`const CHATGPT_CONTAINMENT = '${mode}';`))
      throw Error('Missing containment mode declaration.');
    if (!fs.existsSync(builds[mode])) {
      fs.mkdirSync(builds[mode]);
      fs.cpSync(path.join(repo, 'extension'), path.join(builds[mode], 'extension'), { recursive: true });
      fs.copyFileSync(path.join(repo, 'package.json'), path.join(builds[mode], 'package.json'));
      fs.writeFileSync(path.join(builds[mode], 'extension/overlay.js'), modified);
    } else if (fs.readFileSync(path.join(builds[mode], 'extension/overlay.js'), 'utf8') !== modified)
      throw Error('Source changed: start a new output label.');
  }
}
let referenceHeight = null,
  wheelDelta = null;
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
  __scrollCosts.byteReads = 0;
  const readBytes = atob;
  globalThis.atob = (...args) => {
    __scrollCosts.byteReads++;
    return readBytes(...args);
  };
  __scrollCosts.wheelEvents = 0;
  __scrollCosts.pointerEvents = 0;
  document.addEventListener('wheel', () => __scrollCosts.wheelEvents++, { capture: true, passive: true });
  document.addEventListener('pointermove', () => __scrollCosts.pointerEvents++, { capture: true, passive: true });
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
function traceStats(file, seconds) {
  const data = JSON.parse(fs.readFileSync(file)).traceEvents;
  const main = new Set(
    data.filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => e.tid)
  );
  const events = data.filter((e) => main.has(e.tid) && e.ph === 'X');
  const sum = (name) => events.filter((e) => e.name === name).reduce((a, e) => a + (e.dur || 0) / 1000, 0);
  const byName = {};
  for (const e of events) byName[e.name] = (byName[e.name] || 0) + (e.dur || 0) / 1000;
  const style = events.filter((e) => e.name === 'UpdateLayoutTree');
  return {
    styleMs: sum('UpdateLayoutTree'),
    styleMsPerSecond: sum('UpdateLayoutTree') / seconds,
    layoutMs: sum('Layout'),
    paintMs: sum('Paint'),
    intersectionMs: sum('IntersectionObserverController::computeIntersections'),
    prePaintMs: sum('PrePaint'),
    scriptMs: sum('EvaluateScript') + sum('FunctionCall'),
    runTaskMs: sum('RunTask'),
    styleAffectedElements: style.reduce((a, e) => a + (e.args?.elementCount || e.args?.data?.elementCount || 0), 0),
    styleMaxAffectedElements: Math.max(0, ...style.map((e) => e.args?.elementCount || e.args?.data?.elementCount || 0)),
    mainTaskMaxMs: Math.max(0, ...events.filter((e) => e.name === 'RunTask').map((e) => (e.dur || 0) / 1000)),
    traceDroppedFrames: data.filter((e) => e.name === 'DroppedFrame').length,
    topEvents: Object.entries(byName)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18)
  };
}
function quantile(a, q) {
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
}
async function runOne(condition, repetition, sequenceIndex) {
  const buildKey = condition === 'A' ? null : condition.slice(1);
  const build = buildKey && builds[buildKey];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `sonora-measure-${condition}-`));
  const loadBefore = os.loadavg();
  const startedWall = new Date().toISOString();
  let context,
    cdp,
    s,
    worker,
    page,
    errors = [];
  const args = [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-extension-debugging',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding'
  ];
  if (condition !== 'A')
    args.push(`--disable-extensions-except=${build}/extension`, `--load-extension=${build}/extension`);
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chromiumPath(),
      headless: true,
      viewport: { width: 1440, height: 1000 },
      args
    });
    activeContext = context;
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.route('https://chatgpt.com/**', (r) => r.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('https://chatgpt.com/c/heavy-scroll');
    await page.evaluate(async () => {
      window.__cv = { skipped: 0, unskipped: 0 };
      document.addEventListener(
        'contentvisibilityautostatechange',
        (e) => {
          window.__cv[e.skipped ? 'skipped' : 'unskipped']++;
        },
        true
      );
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const underlyingHeight = await page.evaluate(() => document.querySelector('#chat-scroll').scrollHeight);
    if (referenceHeight === null) {
      referenceHeight = underlyingHeight;
      wheelDelta = (underlyingHeight * 1.4) / 360;
    }
    if (Math.abs(underlyingHeight - referenceHeight) > 1) throw Error('Fixture layout changed between conditions.');
    cdp = await context.newCDPSession(page);
    await cdp.send('Runtime.enable');
    s = { cdp };
    if (condition !== 'A') {
      worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
      await worker.evaluate(
        async (base) => chrome.storage.local.set({ sonoraServer: base, sonoraSpeed: 1 }),
        `http://127.0.0.1:${server.address().port}`
      );
      const id = new URL(worker.url()).hostname;
      cdp.on('Runtime.executionContextCreated', ({ context: cx }) => {
        if (cx.origin === `chrome-extension://${id}` || cx.name === id) s.world = cx.id;
      });
      await cdp.send('Debugger.enable');
      const lines = fs.readFileSync(path.join(build, 'extension/overlay.js'), 'utf8').split('\n');
      const line = lines.findIndex((l) => l.includes('const wordTracker ='));
      if (line < 0) throw new Error('instrumentation breakpoint not found');
      await cdp.send('Debugger.setBreakpointByUrl', {
        lineNumber: line,
        url: `chrome-extension://${id}/overlay.js`,
        condition: `((${instrument.toString()})(),false)`
      });
      const bcdp = await context.browser().newBrowserCDPSession();
      const tab = (
        await bcdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] })
      ).targetInfos.find((t) => t.url.includes('/heavy-scroll'));
      await bcdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
      await page.waitForSelector('#sonora-overlay-root', { state: 'attached' });
      await isolated(s, 'window.__sonoraOverlay.whenIndexed.then(()=>true)');
      await cdp.send('Debugger.disable');
      if (condition[0] === 'D') {
        await page.locator('#text-0').click({ position: { x: 15, y: 12 } });
        for (let i = 0; i < 200; i++) {
          const status = await isolated(
            s,
            `chrome.dom.openOrClosedShadowRoot(document.querySelector('#sonora-overlay-root')).querySelector('.status span').textContent`
          );
          if (/Playing/.test(status)) break;
          await sleep(25);
        }
      }
    }
    await sleep(1500);
    const browserCdp = await context.browser().newBrowserCDPSession();
    let gpu = null;
    try {
      gpu = await browserCdp.send('SystemInfo.getInfo');
    } catch {}
    await cdp.send('Performance.enable');
    await cdp.send('Profiler.enable');
    const preflight = await page.evaluate(() => ({
      height: document.querySelector('#chat-scroll').scrollHeight,
      y: document.querySelector('#chat-scroll').scrollTop,
      cv: window.__cv,
      style: document.querySelector('#sonora-chatgpt-visibility')?.textContent || null,
      turn0: (() => {
        const t = document.querySelector('[data-testid="conversation-turn-0"]');
        const s = getComputedStyle(t);
        return {
          contentVisibility: s.contentVisibility,
          containIntrinsicSize: s.containIntrinsicSize,
          rect: t.getBoundingClientRect().toJSON()
        };
      })(),
      turn2199: (() => {
        const t = document.querySelector('[data-testid="conversation-turn-2199"]');
        const s = getComputedStyle(t);
        return {
          contentVisibility: s.contentVisibility,
          containIntrinsicSize: s.containIntrinsicSize,
          rect: t.getBoundingClientRect().toJSON()
        };
      })()
    }));
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
          if (window.measuring) measure.longtasks.push({ start: e.startTime, duration: e.duration });
      });
      po.observe({ type: 'longtask' });
      function frame(now) {
        if (!window.measuring) return;
        measure.frames.push(now - measure.last);
        measure.last = now;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    const initial = await page.evaluate(() => ({
      height: document.querySelector('#chat-scroll').scrollHeight,
      y: document.querySelector('#chat-scroll').scrollTop,
      stats: { ...siteStats }
    }));
    const previous = condition === 'A' ? null : await isolated(s, '({...__scrollCosts})');
    const traceFile = path.join(
      out,
      `${String(sequenceIndex).padStart(2, '0')}-${condition}-r${repetition}.trace.json`
    );
    const steps = 360,
      interval = 35,
      start = performance.now();
    for (let step = 0; step < steps; step++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 450, deltaX: 0, deltaY: wheelDelta });
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
        endY: document.querySelector('#chat-scroll').scrollTop,
        height: document.querySelector('#chat-scroll').scrollHeight,
        siteStats,
        cv: window.__cv,
        now: performance.now()
      };
    });
    const frames = measurement.frames.filter((dt) => dt > 1).sort((a, b) => a - b);
    const slots = frames.reduce((a, dt) => a + Math.max(1, Math.round(dt / (1000 / 60))), 0);
    const dropped = Math.max(0, slots - frames.length);
    const costs = condition === 'A' ? null : await isolated(s, '({...__scrollCosts})');
    if (costs) for (const k in costs) costs[k] -= previous[k];
    const { profile: cpu } = await cdp.send('Profiler.stop');
    const cpuFile = path.join(out, `${String(sequenceIndex).padStart(2, '0')}-${condition}-r${repetition}.cpuprofile`);
    fs.writeFileSync(cpuFile, JSON.stringify(cpu));
    const loadAfterInput = os.loadavg();
    await traceStop(cdp, traceFile);
    const loadAfter = os.loadavg();
    return {
      condition,
      repetition,
      sequenceIndex,
      build: buildKey || 'none',
      version:
        condition === 'A' ? null : JSON.parse(fs.readFileSync(path.join(build, 'extension/manifest.json'))).version,
      startedWall,
      loadBefore,
      loadAfterInput,
      loadAfter,
      args,
      fixture: { turns: 2200, bytes: Buffer.byteLength(fixture), sha256: fixtureHash },
      browser: context.browser().version(),
      gpu,
      preflight,
      seconds,
      frameP95Ms: quantile(frames, 0.95),
      frameMaxMs: Math.max(0, ...frames),
      frames: frames.length,
      slots,
      droppedFrames: dropped,
      droppedPercent: slots ? (100 * dropped) / slots : 0,
      longTaskCount: measurement.longtasks.length,
      longTaskTotalMs: measurement.longtasks.reduce((a, x) => a + x.duration, 0),
      longTaskMaxMs: Math.max(0, ...measurement.longtasks.map((x) => x.duration)),
      trace: traceStats(traceFile, seconds),
      costs,
      wheelDelta,
      initial,
      end: { y: measurement.endY, height: measurement.height, siteStats: measurement.siteStats, cv: measurement.cv },
      cpuFile,
      traceFile,
      errors
    };
  } finally {
    await context?.close();
    activeContext = null;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
(async () => {
  snapshotBuilds();
  const initial = fs.existsSync(path.join(out, 'runs.json'))
    ? JSON.parse(fs.readFileSync(path.join(out, 'runs.json')))
    : null;
  const hashes = Object.fromEntries(Object.entries(builds).map(([key, build]) => [key, buildHash(build)]));
  if (
    initial &&
    (initial.metadata.fixture.sha256 !== fixtureHash ||
      JSON.stringify(initial.metadata.buildHashes) !== JSON.stringify(hashes) ||
      JSON.stringify(initial.metadata.sequence) !== JSON.stringify(sequence) ||
      initial.metadata.repetitions !== repetitions)
  )
    throw Error('Fixture, builds or configuration changed: use a new output label.');
  referenceHeight = initial?.metadata.referenceHeight ?? null;
  wheelDelta = initial?.metadata.wheelDelta ?? null;
  fs.writeFileSync(path.join(out, 'fixture.html'), fixture);
  const results = initial || {
    metadata: {
      fixture: { turns: 2200, bytes: Buffer.byteLength(fixture), sha256: fixtureHash, scrollport: '#chat-scroll' },
      sequence,
      repetitions,
      viewport: { width: 1440, height: 1000 },
      chromiumPath: chromiumPath(),
      buildHashes: hashes,
      builds,
      cpus: os.cpus().length,
      method:
        'Fresh persistent contexts, fully indexed warmup, interleaved conditions, fixed absolute wheel delta from the uncontained fixture. Live CPU/frame/long-task capture ends before trace export. Adapted from /tmp/measure-runner.cjs.'
    },
    runs: []
  };
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    for (let idx = results.runs.length; idx < sequence.length * repetitions; idx++) {
      if (interrupted) throw Error('Interrupted');
      const rep = Math.floor(idx / sequence.length) + 1,
        condition = sequence[idx % sequence.length];
      const row = await runOne(condition, rep, idx + 1);
      if (row.errors.length) throw Error('Browser console errors: ' + JSON.stringify(row.errors));
      results.runs.push(row);
      results.metadata.referenceHeight = referenceHeight;
      results.metadata.wheelDelta = wheelDelta;
      fs.writeFileSync(path.join(out, 'runs.json'), JSON.stringify(results, null, 2));
      console.log(
        JSON.stringify({
          i: idx + 1,
          condition,
          rep,
          p95: row.frameP95Ms,
          dropped: row.droppedFrames,
          longMs: row.longTaskTotalMs,
          intersectionMs: row.trace.intersectionMs,
          load: row.loadAfterInput.slice(0, 2),
          costs: row.costs
        })
      );
    }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log('DONE', out);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
