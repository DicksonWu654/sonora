const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const tier = process.argv[2] || 'fast';
if (!['fast', 'full'].includes(tier)) throw new Error('Use fast or full.');
const fast = [
  'browser-smoke',
  'text',
  'passages',
  'words',
  'docs',
  'speech',
  'speed',
  'frame-logic',
  'session',
  'extension'
].map((name) => name + '.test.js');
const files =
  tier === 'fast'
    ? fast
    : fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js') && !fast.includes(name));
const output = path.resolve(__dirname, '../output/test-tiers');
fs.mkdirSync(output, { recursive: true });
const metrics = path.join(output, tier + '-launches.jsonl');
fs.writeFileSync(metrics, '');
const log = fs.createWriteStream(path.join(output, tier + '.log'));
const start = performance.now(),
  loadStart = os.loadavg();
const child = spawn(
  process.execPath,
  [
    '--test',
    '--test-reporter=spec',
    ...(tier === 'full' ? ['--test-concurrency=4'] : []),
    ...files.map((name) => path.join(__dirname, name))
  ],
  {
    env: { ...process.env, SONORA_TEST_METRICS: metrics },
    stdio: ['inherit', 'pipe', 'pipe']
  }
);
let text = '';
for (const [stream, destination] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr]
])
  stream.on('data', (data) => {
    destination.write(data);
    log.write(data);
    text += data;
  });
child.on('close', (code, signal) => {
  log.end();
  const launches = fs
    .readFileSync(metrics, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const count = (name) => Number(text.match(new RegExp('ℹ ' + name + ' (\\d+)'))?.[1] || 0);
  const result = {
    tier,
    tests: count('tests'),
    passed: count('pass'),
    failed: count('fail'),
    skipped: count('skipped'),
    browserLaunches: launches.length,
    seconds: (performance.now() - start) / 1000,
    loadStart,
    loadEnd: os.loadavg(),
    exitCode: code,
    signal,
    files,
    launches
  };
  fs.writeFileSync(path.join(output, tier + '.json'), JSON.stringify(result, null, 2));
  console.log(`${tier}: ${result.tests} tests, ${launches.length} browser launch(es), ${result.seconds.toFixed(2)} s`);
  process.exitCode = code ?? 1;
});
