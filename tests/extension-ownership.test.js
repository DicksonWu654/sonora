const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sender = (tab = 1, documentId = 'doc-a') => ({ id: 'sonora', tab: { id: tab }, frameId: 0, documentId });
function background() {
  const local = {};
  let receive, connect, removed, updated;
  const notices = [],
    signals = [];
  const runtime = {
    id: 'sonora',
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: {
      addListener(fn) {
        receive = fn;
      }
    },
    onConnect: {
      addListener(fn) {
        connect = fn;
      }
    }
  };
  const chrome = {
    runtime,
    contextMenus: {
      removeAll(fn) {
        fn();
      },
      create(options, fn) {
        fn();
      },
      onClicked: { addListener() {} }
    },
    action: { onClicked: { addListener() {} } },
    storage: { local: { get: async () => local, set: async (value) => Object.assign(local, value) } },
    tabs: {
      onRemoved: {
        addListener(fn) {
          removed = fn;
        }
      },
      onUpdated: {
        addListener(fn) {
          updated = fn;
        }
      },
      sendMessage: async (tab, message, target) => {
        notices.push({ tab, message, target });
        return { ok: true };
      }
    }
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve('../extension/background.js'), 'utf8').replace(/^import .*;$/gm, ''),
    {
      chrome,
      console,
      AbortController,
      setTimeout,
      clearTimeout,
      SonoraFrames: require('../extension/frames'),
      SonoraValidation: require('../extension/validation'),
      fetch: async (url, { signal }) => {
        signals.push(signal);
        return new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        );
      }
    }
  );
  return {
    local,
    signals,
    notices,
    send: (message, from = sender()) =>
      new Promise((resolve) => {
        if (receive(message, from, resolve) === false) resolve({ ignored: true });
      }),
    disconnect(from = sender()) {
      let disconnect;
      connect?.({
        name: 'sonora-reader',
        sender: from,
        onDisconnect: {
          addListener(fn) {
            disconnect = fn;
          }
        }
      });
      disconnect?.();
    },
    remove: (tab) => removed?.(tab),
    update: (tab, info) => updated?.(tab, info)
  };
}

test('audit2 #5 document disconnect cancels abandoned synthesis without cancelling a new document', async (t) => {
  const h = background();
  t.after(async () => {
    await h.send({ type: 'sonora-cancel-render', requestId: 'old' });
    await h.send({ type: 'sonora-cancel-render', requestId: 'new' }, sender(1, 'doc-b'));
  });
  const old = h.send({ type: 'sonora-render', requestId: 'old', text: 'Old paragraph.' });
  const current = h.send({ type: 'sonora-render', requestId: 'new', text: 'New paragraph.' }, sender(1, 'doc-b'));
  await tick();
  h.disconnect();
  await tick();
  assert.equal(h.signals[0].aborted, true);
  assert.equal(h.signals[1].aborted, false);
  assert.match((await old).error, /closed|left|disconnect|cancel/i);
  h.remove(1);
  assert.match((await current).error, /closed|left|cancel/i);
});

test('audit2 #8 a new playback owner pauses the previous tab and document', async () => {
  const h = background();
  await h.send({ type: 'sonora-claim-playback' }, sender());
  await h.send({ type: 'sonora-claim-playback' }, sender(2, 'doc-b'));
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].tab, 1);
  assert.equal(h.notices[0].target.documentId, 'doc-a');
  assert.equal(h.notices[0].message.type, 'sonora-pause-playback');
});

test('audit2 #22 concurrent tabs retain a bounded set of independent reading positions', async () => {
  const h = background();
  await Promise.all(
    Array.from({ length: 25 }, (_, at) =>
      h.send({
        type: 'sonora-save-position',
        record: {
          document: 'https://article.test/' + at,
          prefix: 'Paragraph',
          text: 'Paragraph ' + at,
          offset: 0,
          blockIndex: at
        }
      })
    )
  );
  assert.equal(h.local.sonoraPositions?.length, 20);
  assert.equal(new Set(h.local.sonoraPositions.map((r) => r.document)).size, 20);
  const response = await h.send({
    type: 'sonora-save-position',
    record: { document: 'bad', prefix: '', text: 'x'.repeat(10000), offset: 0, blockIndex: 0 }
  });
  assert.equal(response.ok, false);
  assert.equal(h.local.sonoraPositions.length, 20);
});
