// Extension pages may use loopback narration, never the private studio/feed API.
function extensionOrigin(req) {
  const origin = req.headers.origin || '';
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : null;
}

function localRequest(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL('http://' + req.headers.host).hostname);
  } catch { return false; }
}

function extensionAccess(req, pathname) {
  const origin = extensionOrigin(req);
  if (!origin || !localRequest(req)) return null;
  const route = /^\/api\/narration\/(?:status|render|audio\/[a-f0-9]{64}\.wav)$/.test(pathname);
  return route ? origin : null;
}

module.exports = { extensionOrigin, extensionAccess, localRequest };
