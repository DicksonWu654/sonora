// Interleaved before/after of the independent auditor's exact Claude fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { claudeHtml } = require('../tests/helpers/claude');
const repo = path.resolve(__dirname, '..');
const modulePath =
  process.env.SONORA_PLAYWRIGHT ||
  fs
    .readdirSync(path.join(os.homedir(), '.npm/_npx'))
    .map((name) => path.join(os.homedir(), '.npm/_npx', name, 'node_modules/playwright'))
    .find((file) => fs.existsSync(file));
if (!modulePath) throw new Error('Install Playwright or set SONORA_PLAYWRIGHT to its module directory.');
const { chromium } = require(modulePath);
const { chromiumPath } = require('../tests/helpers/browser');
const output = path.resolve(repo, process.argv[2] || 'output/playwright/audit2-perf');
const baseline = process.env.SONORA_PERF_BASELINE || 'ca5f882';
const repetitions = Number(process.env.SONORA_PERF_REPS || 3);
if (!Number.isInteger(repetitions) || repetitions < 3) throw new Error('Use at least three interleaved repetitions.');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function instrument() {
  window.auditWork = { visible: 0 };
  const visible = SonoraPassages.visibleBlock;
  SonoraPassages.visibleBlock = (...args) => {
    auditWork.visible++;
    return visible(...args);
  };
}
function quantile(values, p) {
  const a = [...values].sort((a, b) => a - b),
    at = (a.length - 1) * p;
  return a[Math.floor(at)] + (a[Math.ceil(at)] - a[Math.floor(at)]) * (at % 1);
}
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-mutations-'));
  const result = { baseline, repetitions, fixtureHashes: {}, runs: [], summary: {} };
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ready: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const before = path.join(temporary, 'before'),
    after = path.join(temporary, 'after');
  fs.mkdirSync(before);
  fs.mkdirSync(after);
  execFileSync('tar', ['-x', '-C', before], {
    input: execFileSync('git', ['archive', baseline, 'extension'], { cwd: repo })
  });
  fs.cpSync(path.join(repo, 'extension'), path.join(after, 'extension'), { recursive: true });
  result.buildHashes = Object.fromEntries(
    [
      ['before', before],
      ['after', after]
    ].map(([name, directory]) => {
      const extension = path.join(directory, 'extension');
      return [
        name,
        hash(
          fs
            .readdirSync(extension)
            .sort()
            .map((file) => file + fs.readFileSync(path.join(extension, file)))
            .join('')
        )
      ];
    })
  );
  let context;
  try {
    for (const count of [100, 1000]) {
      const fixture = claudeHtml(count);
      result.fixtureHashes[count] = hash(fixture);
      for (let rep = 0; rep < repetitions; rep++)
        for (const condition of rep % 2 ? ['after', 'before'] : ['before', 'after']) {
          const build = condition === 'before' ? before : after,
            extension = path.join(build, 'extension');
          const id = hash(extension)
            .slice(0, 32)
            .replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
          const profile = path.join(temporary, `profile-${count}-${rep}-${condition}`);
          const loadStart = os.loadavg();
          context = await chromium.launchPersistentContext(profile, {
            executablePath: chromiumPath(),
            headless: true,
            viewport: { width: 1440, height: 1000 },
            args: [
              '--no-sandbox',
              '--enable-unsafe-extension-debugging',
              `--disable-extensions-except=${extension}`,
              `--load-extension=${extension}`
            ]
          });
          const worker =
            context.serviceWorkers().find((w) => w.url() === `chrome-extension://${id}/background.js`) ||
            (await context.waitForEvent('serviceworker', {
              predicate: (w) => w.url() === `chrome-extension://${id}/background.js`
            }));
          await worker.evaluate(
            (base) => chrome.storage.local.set({ sonoraServer: base }),
            `http://127.0.0.1:${server.address().port}`
          );
          const page = await context.newPage(),
            url = `https://claude.ai/chat/perf-${count}-${rep}-${condition}`;
          await page.route(url, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
          await page.goto(url);
          const cdp = await context.newCDPSession(page);
          let world;
          cdp.on('Runtime.executionContextCreated', ({ context: cx }) => {
            if (cx.origin === `chrome-extension://${id}` || cx.name === id) world = cx.id;
          });
          await cdp.send('Runtime.enable');
          await cdp.send('Debugger.enable');
          const line = fs
            .readFileSync(path.join(extension, 'overlay.js'), 'utf8')
            .split('\n')
            .findIndex((l) => l.includes('const wordTracker ='));
          await cdp.send('Debugger.setBreakpointByUrl', {
            lineNumber: line,
            url: `chrome-extension://${id}/overlay.js`,
            condition: `((${instrument.toString()})(),false)`
          });
          const bcdp = await context.browser().newBrowserCDPSession();
          const tab = (
            await bcdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] })
          ).targetInfos.find((t) => t.url === url);
          await bcdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
          await page.waitForSelector('#sonora-overlay-root', { state: 'attached' });
          const isolated = async (expression) => {
            const r = await cdp.send('Runtime.evaluate', {
              expression,
              contextId: world,
              awaitPromise: true,
              returnByValue: true
            });
            if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
            return r.result.value;
          };
          await isolated('window.__sonoraOverlay.whenIndexed.then(()=>true)');
          await sleep(300);
          await cdp.send('Debugger.disable');
          await cdp.send('Performance.enable');
          await isolated('auditWork.visible=0');
          const start = await cdp.send('Performance.getMetrics');
          await page.evaluate(async () => {
            for (let i = 0; i < 12; i++) {
              document.querySelector('#ui').textContent = i % 2 ? 'Copy' : 'Copied';
              await new Promise((r) => setTimeout(r, 150));
            }
          });
          await sleep(1000);
          const end = await cdp.send('Performance.getMetrics');
          const delta = (name) =>
            1000 * (end.metrics.find((m) => m.name === name).value - start.metrics.find((m) => m.name === name).value);
          const row = {
            count,
            rep,
            condition,
            loadStart,
            loadEnd: os.loadavg(),
            scriptMs: delta('ScriptDuration'),
            taskMs: delta('TaskDuration'),
            ...(await isolated('({...auditWork})'))
          };
          result.runs.push(row);
          console.log(JSON.stringify(row));
          await context.close();
          context = null;
          fs.rmSync(profile, { recursive: true, force: true });
          fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(result, null, 2));
        }
      result.summary[count] = {};
      for (const condition of ['before', 'after']) {
        const rows = result.runs.filter((r) => r.count === count && r.condition === condition);
        result.summary[count][condition] = {};
        for (const name of ['scriptMs', 'taskMs', 'visible']) {
          const values = rows.map((r) => r[name]);
          result.summary[count][condition][name] = {
            median: quantile(values, 0.5),
            iqr: quantile(values, 0.75) - quantile(values, 0.25)
          };
        }
      }
    }
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(result, null, 2));
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
