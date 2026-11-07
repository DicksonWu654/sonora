const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function background() {
  const local = {};
  let receive;
  const event = { addListener() {} };
  const chrome = {
    runtime: {
      id: 'sonora',
      onInstalled: event,
      onStartup: event,
      onMessage: {
        addListener(fn) {
          receive = fn;
        }
      }
    },
    contextMenus: {
      onClicked: event,
      removeAll(callback) {
        callback();
      },
      create(options, callback) {
        callback();
      }
    },
    action: { onClicked: event },
    storage: {
      local: {
        get: async () => local,
        set: async (value) => Object.assign(local, value)
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
      SonoraValidation: require('../extension/validation')
    }
  );
  return {
    local,
    send: (message) => new Promise((resolve) => receive(message, { id: 'sonora', tab: { id: 1 }, frameId: 0 }, resolve))
  };
}

test('concurrent reading positions remain independent and bounded', async () => {
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
    record: {
      document: 'bad',
      prefix: '',
      text: 'x'.repeat(10000),
      offset: 0,
      blockIndex: 0
    }
  });
  assert.equal(response.ok, false);
  assert.equal(h.local.sonoraPositions.length, 20);
});
