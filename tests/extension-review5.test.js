const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const frames = require('../extension/frames');
const { browser } = require('./helpers/browser');

const embed = (index, url, area = 500000) => ({ path: [index], url, area });
const child = (frameId, index, url, score = 500) => ({
  frameId,
  documentId: 'doc-' + frameId,
  result: { path: [index], url, score, readable: score >= 160, sample: score ? 'readable' : 'empty', frames: [] }
});

function background(top, children = [], loaded = []) {
  let action, receive;
  const scripts = [],
    calls = [],
    opened = [],
    notices = [],
    choices = [];
  const storage = {};
  const chrome = {
    runtime: {
      id: 'sonora',
      getManifest: () => ({ version: 'test' }),
      getURL: file => 'chrome-extension://sonora/' + file,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(fn) {
          receive = fn;
        }
      }
    },
    contextMenus: {
      removeAll(fn) {
        fn();
      },
      create(options, fn) {
        fn();
      },
      onClicked: { addListener() {} }
    },
    action: {
      onClicked: {
        addListener(fn) {
          action = fn;
        }
      }
    },
    storage: {
      local: { get: async () => ({}) },
      session: {
        get: async () => storage,
        set: async value => Object.assign(storage, value),
        remove: async key => {
          delete storage[key];
        }
      }
    },
    permissions: { contains: async () => false },
    webNavigation: {
      getAllFrames: async () => [
        { frameId: 0, parentFrameId: -1, documentId: 'doc-0', url: 'https://parent.test/page' },
        ...loaded
      ]
    },
    tabs: {
      create: async value => {
        opened.push(value);
      },
      update: async () => {},
      get: async id => ({ id, url: 'https://parent.test/page' }),
      sendMessage: async (...args) => {
        notices.push(args);
        return { ok: true };
      }
    },
    scripting: {
      insertCSS: async () => {},
      removeCSS: async () => {},
      executeScript: async options => {
        calls.push(options);
        if (options.func?.name === 'probeFrame')
          return options.target.allFrames
            ? [{ frameId: 0, documentId: 'doc-0', result: top }, ...children]
            : [{ frameId: 0, documentId: 'doc-0', result: top }];
        if (options.files) scripts.push(options.target.frameIds?.[0] ?? 0);
        if (options.args?.[2]) choices.push(options.args[2]);
        return [{ result: false }];
      }
    }
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve('../extension/background.js'), 'utf8').replace(/^import .*;$/gm, ''),
    {
      chrome,
      SonoraFrames: frames,
      SonoraValidation: require('../extension/validation'),
      console,
      URL,
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: async () => ({ json: async () => ({ ready: true }) })
    }
  );
  return {
    scripts,
    calls,
    opened,
    notices,
    choices,
    action: () => action({ id: 1, url: 'https://parent.test/page' }),
    send: (type, document = 'embedded') =>
      new Promise(resolve => {
        const pending = receive(
          { type, document },
          { id: 'sonora', tab: { id: 1 }, frameId: 0, documentId: 'doc-0' },
          resolve
        );
        if (pending !== true) resolve({ ignored: true });
      })
  };
}

test('review5 #1 readable top prose offers an explicit embedded document switch', async () => {
  const url = 'https://embed.test/doc';
  const h = background({ path: [], readable: true, sample: 'readable', score: 222, frames: [embed(0, url)] }, [
    child(7, 0, url)
  ]);
  await h.action();
  assert.deepEqual(h.scripts, [0]);
  assert(
    h.choices.some(choice => choice.embedded),
    'the top reader must expose the embedded document choice'
  );
  await h.send('sonora-switch-document');
  assert.equal(h.scripts.at(-1), 7);
});

test('review5 #2 switching frames disposes the previous reader before injection', async () => {
  const url = 'https://embed.test/doc';
  const top = { path: [], readable: false, sample: 'empty', score: 0, frames: [embed(0, url)] };
  const h = background(top, [child(7, 0, url)]);
  await h.action();
  assert.deepEqual(h.scripts, [7]);
  top.readable = true;
  top.sample = 'readable';
  top.score = 222;
  await h.action();
  assert.equal(h.scripts.at(-1), 0);
  assert(
    h.notices.some(
      ([tab, message, target]) =>
        message.type === 'sonora-dispose-reader' && (target?.documentId === 'doc-7' || target?.frameId === 7)
    ),
    'the previous frame must be disposed'
  );
});

test('review5 #2 a late playback claim from a retired document cannot steal the active frame', async () => {
  const url = 'https://embed.test/doc';
  const h = background({ path: [], readable: false, sample: 'empty', score: 0, frames: [embed(0, url)] }, [
    child(7, 0, url)
  ]);
  await h.action();
  const response = await h.send('sonora-claim-playback');
  assert.equal(response.data.owned, false);
  assert(
    !h.notices.some(([, message, target]) => message.type === 'sonora-pause-playback' && target?.documentId === 'doc-7')
  );
});

test('review5 #3 permission uses the loaded frame URL after an internal navigation', async () => {
  const h = background(
    { path: [], readable: false, sample: 'empty', score: 0, frames: [embed(0, 'https://old.embed.test/doc')] },
    [],
    [{ frameId: 7, parentFrameId: 0, documentId: 'doc-7', url: 'https://new.embed.test/doc' }]
  );
  await h.action();
  assert.equal(new URL(h.opened[0]?.url).searchParams.get('origin'), 'https://new.embed.test/*');
});

test('review5 #3 loaded frame association does not assume browser inventory order matches DOM order', async () => {
  const top = {
    path: [],
    readable: false,
    sample: 'empty',
    score: 0,
    documents: [
      { path: [0], sourceUrl: 'https://static.test/doc' },
      { path: [1], sourceUrl: 'https://old.embed.test/doc' }
    ],
    frames: [embed(1, 'https://old.embed.test/doc')]
  };
  const h = background(
    top,
    [],
    [
      { frameId: 7, parentFrameId: 0, url: 'https://new.embed.test/doc' },
      { frameId: 8, parentFrameId: 0, url: 'https://static.test/doc' }
    ]
  );
  await h.action();
  assert.equal(new URL(h.opened[0]?.url).searchParams.get('origin'), 'https://new.embed.test/*');
});

test('review5 #4 frame exposure excludes ancestor clipping and ranks the visible article', async t => {
  const page = await browser(
    t,
    '<style>body{margin:0}iframe{border:0}.clip{height:0;overflow:hidden}</style><div class="clip"><iframe width="1200" height="800"></iframe></div><iframe width="700" height="600"></iframe>',
    'https://parent.test/page'
  );
  if (!page) return;
  const result = await page.evaluate(`(${frames.probeFrame.toString()})()`);
  assert.equal(
    result.frames.some(frame => frame.path[0] === 0),
    false
  );
  assert.equal(result.frames[0]?.path[0], 1);
});

test('review5 #4 nested frame areas include the exposed part of every ancestor', () => {
  const outer = {
    path: [0],
    area: 500000,
    clip: { left: 0, top: 0, right: 500, bottom: 1000 },
    content: { left: 0, top: 0, width: 1000, height: 1000 },
    scaleX: 1,
    scaleY: 1
  };
  const hidden = { path: [0, 0], area: 400000, clip: { left: 600, top: 0, right: 1000, bottom: 1000 } };
  const shown = { path: [0, 1], area: 400000, clip: { left: 200, top: 0, right: 600, bottom: 1000 } };
  const top = { frames: [outer] };
  const results = [
    { frameId: 7, result: { path: [0], score: 0, frames: [hidden, shown] } },
    { frameId: 8, result: { path: [0, 0], readable: true, score: 500, frames: [] } },
    { frameId: 9, result: { path: [0, 1], readable: true, score: 500, frames: [] } }
  ];
  const ranked = frames.candidates(top, results);
  assert.equal(
    ranked.some(frame => frame.frameId === 8),
    false
  );
  assert.equal(ranked.find(frame => frame.frameId === 9).area, 300000);
});

test('review5 #5 a proven readable frame wins before a larger uninspected advertisement', async () => {
  const top = {
    path: [],
    readable: false,
    sample: 'empty',
    score: 0,
    frames: [embed(0, 'https://ads.test/ad', 455000), embed(1, 'https://docs.test/article', 336000)]
  };
  const h = background(
    top,
    [child(8, 1, 'https://docs.test/article')],
    [
      { frameId: 7, parentFrameId: 0, url: 'https://ads.test/ad' },
      { frameId: 8, parentFrameId: 0, url: 'https://docs.test/article' }
    ]
  );
  await h.action();
  assert.deepEqual(h.scripts, [8]);
  assert.equal(h.opened.length, 0);
});

test('review5 #6 short readable top prose stays selected instead of an advertisement', async () => {
  const top = {
    path: [],
    readable: false,
    sample: 'inconclusive',
    score: 62,
    frames: [embed(0, 'https://ads.test/ad', 75000)]
  };
  const h = background(top, [child(7, 0, 'https://ads.test/ad')]);
  await h.action();
  assert.deepEqual(h.scripts, [0]);
  assert.equal(h.opened.length, 0);
});

test('review5 #6 a budget-exhausted top sample is inconclusive and does not request ad access', async t => {
  const page = await browser(
    t,
    '<main>' +
      '<div><span></span></div>'.repeat(300) +
      '<p>' +
      'Long article. '.repeat(10000) +
      '</p><iframe width="300" height="250"></iframe></main>',
    'https://parent.test/page'
  );
  if (!page) return;
  const result = await page.evaluate(`(${frames.probeFrame.toString()})()`);
  assert.equal(result.sample, 'inconclusive');
  const h = background(result, [child(7, 0, 'https://ads.test/ad')]);
  await h.action();
  assert.deepEqual(h.scripts, [0]);
  assert.equal(h.opened.length, 0);
});

test('review5 #7 Claude artifact grants cover that service while other sites keep exact origins', () => {
  assert.equal(
    frames.originPattern('https://one.frame.claudeusercontent.com/doc'),
    'https://*.frame.claudeusercontent.com/*'
  );
  assert.equal(
    frames.originPattern('https://two.frame.claudeusercontent.com/doc'),
    'https://*.frame.claudeusercontent.com/*'
  );
  assert.equal(
    frames.originPattern('https://claudeusercontent.com.attacker.test/doc'),
    'https://claudeusercontent.com.attacker.test/*'
  );
  assert.equal(frames.originPattern('https://docs.test/article'), 'https://docs.test/*');
});
