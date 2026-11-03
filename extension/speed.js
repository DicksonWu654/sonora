(function (root) {
  const MIN_SPEED = 1;
  const MAX_SPEED = 3;
  const SPEED_STEP = 0.1;

  function normalizeSpeed(value, fallback = 1) {
    const raw = Number(value);
    const candidate = Number.isFinite(raw) ? raw : fallback;
    const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, candidate));
    return Math.round((clamped + Number.EPSILON) * 10) / 10;
  }

  function formatSpeed(value) {
    const speed = normalizeSpeed(value);
    return `${speed.toFixed(1).replace(/\.0$/, '')}×`;
  }

  const api = { MIN_SPEED, MAX_SPEED, SPEED_STEP, normalizeSpeed, formatSpeed };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraSpeed = api;
})(globalThis);
