// node tools/summarize-scroll.cjs baseline -- current
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../output/scroll');
const args = process.argv.slice(2);
const divider = args.indexOf('--');
if (divider < 1 || divider === args.length - 1) throw new Error('Pass before labels, --, then after labels.');

function cpuRows(file) {
  const input = JSON.parse(fs.readFileSync(file));
  const totals = new Map();
  for (const profile of Array.isArray(input) ? input : [input]) {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    profile.samples.forEach((id, index) => {
      const frame = nodes.get(id).callFrame;
      const location = frame.url.replace(/^chrome-extension:\/\/[^/]+\//, 'extension/');
      const key = JSON.stringify([frame.functionName || '(anonymous)', location, frame.lineNumber + 1]);
      totals.set(key, (totals.get(key) || 0) + profile.timeDeltas[index] / 1000);
    });
  }
  return [...totals]
    .map(([key, selfMs]) => {
      const [functionName, file, line] = JSON.parse(key);
      return { functionName, file, line, selfMs };
    })
    .sort((a, b) => b.selfMs - a.selfMs);
}

function pipelineStats(file) {
  const events = JSON.parse(fs.readFileSync(file))
    .traceEvents.filter((event) => event.name === 'PipelineReporter')
    .sort((a, b) => a.ts - b.ts);
  const states = {},
    starts = new Map(),
    durations = [];
  for (const event of events) {
    const key = event.pid + ':' + event.id2?.local;
    if (event.ph === 'b') {
      const state = event.args.frame_reporter.state;
      states[state] = (states[state] || 0) + 1;
      starts.set(key, event);
    } else if (event.ph === 'e' && starts.has(key)) {
      const begin = starts.get(key);
      if (begin.args.frame_reporter.state !== 'STATE_NO_UPDATE_DESIRED') durations.push((event.ts - begin.ts) / 1000);
      starts.delete(key);
    }
  }
  durations.sort((a, b) => a - b);
  const desired = Object.entries(states).reduce(
    (total, [state, count]) => total + (state === 'STATE_NO_UPDATE_DESIRED' ? 0 : count),
    0
  );
  return {
    states,
    droppedReportsPercent: (100 * (states.STATE_DROPPED || 0)) / desired,
    pipelineDurationP95Ms: durations[Math.floor(durations.length * 0.95)]
  };
}

function merge(labels) {
  const result = { labels, conditions: {}, profiles: {} };
  for (const label of labels) {
    const run = JSON.parse(fs.readFileSync(path.join(root, label, 'results.json')));
    result.version = run.version;
    result.browser = run.browser;
    result.fixture = run.fixture;
    for (const [condition, value] of Object.entries(run.conditions)) {
      const phases = {};
      for (const [phase, data] of Object.entries(value.phases)) {
        phases[phase] = {
          seconds: data.seconds,
          frameP95Ms: data.frameP95Ms,
          droppedPercent: data.droppedPercent,
          longTasks: data.longTasks.length,
          longTaskMaxMs: Math.max(0, ...data.longTasks.map((task) => task.duration)),
          ...data.trace,
          cdpPipeline: pipelineStats(path.join(root, label, condition + '-' + phase + '.trace.json')),
          layoutMsPerSecond: data.trace.layoutMs / data.seconds,
          paintMsPerSecond: data.trace.paintMs / data.seconds,
          costs: data.costs,
          initial: data.initial,
          end: data.end
        };
      }
      result.conditions[condition] = {
        openMs: value.openMs,
        phases,
        consoleErrors: value.consoleErrors,
        status: value.status
      };
      const rows = cpuRows(path.join(root, label, condition + '.cpuprofile'));
      result.profiles[condition] = {
        top: rows.slice(0, 20),
        extension: rows.filter((row) => row.file.startsWith('extension/')).slice(0, 20)
      };
    }
  }
  return result;
}

const before = merge(args.slice(0, divider));
const after = merge(args.slice(divider + 1));
const comparison = {};
for (const condition of ['C', 'D']) {
  comparison[condition] = {};
  for (const phase of ['scroll', 'hover']) {
    const baseline = after.conditions.A.phases[phase];
    const value = after.conditions[condition].phases[phase];
    comparison[condition][phase] = {
      frameP95RatioToA: value.frameP95Ms / baseline.frameP95Ms,
      droppedRatioToA: value.droppedPercent / baseline.droppedPercent,
      droppedDifferencePercentagePoints: value.droppedPercent - baseline.droppedPercent,
      meetsFivePercent:
        value.frameP95Ms <= baseline.frameP95Ms * 1.05 && value.droppedPercent <= baseline.droppedPercent * 1.05
    };
  }
}
const summary = {
  methodology:
    'Unpacked MV3, real toolbar, 2200 turns, 600 CDP wheel inputs top to bottom plus mouse moves, then 100 hover moves. CDP trace/CPU profiler and rAF/LongTask observer. Live measurements stop before trace export; CPU samples cover the input phases only.',
  limitations:
    'Synthetic site, headless Chromium, shared busy host. Frame p95 is rAF interval; dropped percent estimates missed 60 Hz rAF slots. CDP pipeline states, dropped reports and pipeline duration are separate fields (reporters can include partial main/compositor updates). Runs include discovery overlap. No extension content script executes in A or B.',
  before,
  after,
  comparison
};
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
for (const condition of ['A', 'B', 'C', 'D']) {
  for (const phase of ['scroll', 'hover']) {
    const cells = [before, after].map((run) => {
      const value = run.conditions[condition].phases[phase];
      return `${value.frameP95Ms.toFixed(1)}ms / ${value.droppedPercent.toFixed(1)}% / ${value.longTasks} / ${value.styleMsPerSecond.toFixed(1)}ms/s`;
    });
    console.log(condition, phase, cells.join(' -> '));
  }
}
console.log(JSON.stringify(comparison, null, 2));
