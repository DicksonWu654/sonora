(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SonoraValidation = api;
})(globalThis, () => {
  const DEFAULT_SERVER = 'http://127.0.0.1:8787';
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const AUDIO_PATH = /^\/api\/narration\/audio\/[a-f0-9]{64}\.wav$/;

  function normalizeServerUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return DEFAULT_SERVER;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || (url.pathname !== '/' && url.pathname) || url.search || url.hash) return DEFAULT_SERVER;
      return url.origin;
    } catch {
      return DEFAULT_SERVER;
    }
  }

  function audioUrlFor(base, value) {
    let baseUrl;
    let audioUrl;
    try {
      baseUrl = new URL(normalizeServerUrl(base));
      audioUrl = new URL(value, baseUrl);
    } catch {
      throw new Error('Sonora returned an invalid audio URL.');
    }
    if (audioUrl.origin !== baseUrl.origin || audioUrl.protocol !== baseUrl.protocol || audioUrl.search || audioUrl.hash || !AUDIO_PATH.test(audioUrl.pathname)) {
      throw new Error('Sonora returned an invalid audio URL.');
    }
    return audioUrl;
  }

  function validRenderText(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) return false;
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
  }

  return { DEFAULT_SERVER, normalizeServerUrl, audioUrlFor, validRenderText };
});
