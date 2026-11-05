// node tools/summarize-scroll.cjs <study-label> [containment-study-label].
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../output/scroll');
const label = process.argv[2] || 'interleaved';
const input = JSON.parse(fs.readFileSync(path.join(root, label, 'runs.json')));
const containmentLabel = process.argv[3];
const containmentStudy = containmentLabel && JSON.parse(fs.readFileSync(path.join(root, containmentLabel, 'summary.json')));
function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function distribution(values) {
  const median = quantile(values, 0.5),
    q1 = quantile(values, 0.25),
    q3 = quantile(values, 0.75);
  return { median, q1, q3, iqr: q3 - q1, samples: values };
}
function cpuSelfTime(rows) {
  const totals = new Map();
  for (const row of rows) {
    const profile = JSON.parse(fs.readFileSync(row.cpuFile));
    const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
    profile.samples.forEach((id, at) => {
      const frame = nodes.get(id);
      const key = JSON.stringify([
        frame.functionName || '(anonymous)',
        frame.url.replace(/^chrome-extension:\/\/[^/]+\//, 'extension/'),
        frame.lineNumber + 1
      ]);
      totals.set(key, (totals.get(key) || 0) + profile.timeDeltas[at] / 1000);
    });
  }
  return [...totals]
    .map(([key, selfMs]) => {
      const [name, file, line] = JSON.parse(key);
      return { name, file, line, selfMs };
    })
    .sort((a, b) => b.selfMs - a.selfMs);
}
const conditions = {};
for (const condition of input.metadata.sequence) {
  const rows = input.runs.filter((row) => row.condition === condition);
  if (rows.length < 5) throw Error('Need five repetitions for ' + condition);
  if (
    rows.some(
      (row) =>
        row.fixture.sha256 !== input.metadata.fixture.sha256 ||
        row.wheelDelta !== input.metadata.wheelDelta ||
        row.errors.length
    )
  )
    throw Error('Inconsistent fixture/path or browser errors');
  const metrics = {};
  for (const key of [
    'frameP95Ms',
    'droppedFrames',
    'droppedPercent',
    'longTaskCount',
    'longTaskTotalMs',
    'longTaskMaxMs',
    'seconds'
  ])
    metrics[key] = distribution(rows.map((row) => row[key]));
  for (const key of ['styleMs', 'styleMsPerSecond', 'layoutMs', 'paintMs', 'prePaintMs', 'intersectionMs', 'styleAffectedElements'])
    metrics[key] = distribution(rows.map((row) => row.trace[key]));
  const costs = rows[0].costs
    ? Object.fromEntries(
        Object.keys(rows[0].costs).map((key) => [key, distribution(rows.map((row) => row.costs[key]))])
      )
    : null;
  const cpu = cpuSelfTime(rows);
  conditions[condition] = {
    repetitions: rows.length,
    metrics,
    costs,
    loadBefore: rows.map((row) => row.loadBefore),
    loadAfterInput: rows.map((row) => row.loadAfterInput),
    cpu: { top: cpu.slice(0, 20), extension: cpu.filter((row) => row.file.startsWith('extension/')).slice(0, 20) }
  };
}
const a = conditions.A.metrics;
const variants = ['none', 'turn', 'coarse']
  .filter(mode => conditions['C' + mode] && conditions['D' + mode])
  .map((mode) => {
    const ratios = ['C', 'D'].flatMap((prefix) =>
      ['droppedFrames', 'longTaskTotalMs'].map(
        (metric) => conditions[prefix + mode].metrics[metric].median / Math.max(1, a[metric].median)
      )
    );
    return {
      mode,
      worstRatio: Math.max(...ratios),
      meanRatio: ratios.reduce((sum, value) => sum + value, 0) / ratios.length
    };
  })
  .sort((left, right) => left.worstRatio - right.worstRatio || left.meanRatio - right.meanRatio);
const selected = process.env.SCROLL_SELECTED || variants[0].mode;
const table = ['A', 'C048', 'D048', 'C' + selected, 'D' + selected].map((condition) => ({
  condition,
  frameP95Ms: conditions[condition].metrics.frameP95Ms,
  droppedFrames: conditions[condition].metrics.droppedFrames,
  droppedPercent: conditions[condition].metrics.droppedPercent,
  longTaskTotalMs: conditions[condition].metrics.longTaskTotalMs,
  styleMsPerSecond: conditions[condition].metrics.styleMsPerSecond
}));
const target = Object.fromEntries(
  ['C', 'D'].map((prefix) => {
    const metrics = conditions[prefix + selected].metrics;
    return [
      prefix,
      {
        droppedAtOrBelowA: metrics.droppedFrames.median <= a.droppedFrames.median,
        longTaskMsAtOrBelowA: metrics.longTaskTotalMs.median <= a.longTaskTotalMs.median
      }
    ];
  })
);
const summary = {
  metadata: input.metadata,
  study: label,
  selection: {
    selected,
    rule: 'Minimize the worst ratio to A across idle/reading median dropped frames and long-task milliseconds; mean ratio breaks ties.',
    variants
  },
  target,
  table,
  conditions,
  ...(containmentStudy ? { containmentComparison: {
    study: containmentLabel, metadata: containmentStudy.metadata,
    selection: containmentStudy.selection, conditions: containmentStudy.conditions
  } } : {}),
  limitations:
    'Headless Chromium/SwiftShader on a shared host. Frame p95 and dropped slots are rAF-based; CDP traces retain native rendering/intersection work. Only input intervals are measured; trace export is excluded. All conditions use one hashed inner-scrollport fixture and one absolute wheel delta.'
};
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(root, label, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const format = (value) => `${value.median.toFixed(1)} [${value.q1.toFixed(1)}, ${value.q3.toFixed(1)}]`;
for (const [condition, value] of Object.entries(conditions))
  console.log(
    condition,
    'p95',
    format(value.metrics.frameP95Ms),
    'dropped',
    format(value.metrics.droppedFrames),
    'long ms',
    format(value.metrics.longTaskTotalMs),
    'intersections',
    format(value.metrics.intersectionMs)
  );
console.log('Selection', JSON.stringify(summary.selection));
console.log('Target', JSON.stringify(target));
