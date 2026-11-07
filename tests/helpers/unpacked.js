const { once } = require('node:events');

async function connect(t, url, runtime = true) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  t.after(() => socket.close());
  let sequence = 0;
  const pending = new Map(),
    errors = [];
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('Extension target closed.'));
    pending.clear();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Extension target closed.'));
        return;
      }
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  if (runtime) await send('Runtime.enable');
  return { send, evaluate, errors };
}
async function target(t, port, predicate) {
  const deadline = Date.now() + 15000;
  do {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const value = targets.find(predicate);
    if (value) return { ...(await connect(t, value.webSocketDebuggerUrl)), target: value };
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error('Extension target did not appear.');
}
async function resetExtension(worker) {
  await worker.evaluate(`(async()=>{
    const fixed=chrome.runtime.getManifest().host_permissions||[];
    const granted=await chrome.permissions.getAll();
    const requiredHosts=new Set(fixed.map(origin=>new URL(origin).hostname));
    const optional=(granted.origins||[]).filter(origin=>!requiredHosts.has(new URL(origin).hostname));
    if(optional.length)await chrome.permissions.remove({origins:optional});
    await chrome.storage.local.clear();await chrome.storage.session.clear();
  })()`);
}
module.exports = { connect, target, resetExtension };
