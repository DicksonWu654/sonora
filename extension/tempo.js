(function (root) {
  // Waveform-similarity overlap-add: change duration by skipping/repeating
  // aligned windows, never by resampling (which changes the voice's pitch).
  function stretch(channels, sampleRate, rate) {
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 3) throw new Error('Invalid playback speed.');
    const length = channels[0]?.length || 0;
    if (!length || rate === 1) return channels;
    const frame = Math.max(32, Math.round(sampleRate * 0.04));
    const overlap = Math.max(16, Math.round(sampleRate * 0.012));
    const hop = frame - overlap;
    const search = Math.round(sampleRate * 0.012);
    const outputLength = Math.max(1, Math.round(length / rate));
    const output = channels.map(() => new Float32Array(outputLength));
    const input = channels[0];
    output.forEach((channel, index) => channel.set(channels[index].subarray(0, Math.min(frame, outputLength))));
    for (let at = hop; at < outputLength; at += hop) {
      const expected = Math.round(at * rate);
      const low = Math.max(0, expected - search);
      const high = Math.min(length - overlap, expected + search);
      let chosen = Math.max(0, Math.min(length - 1, expected));
      let best = -Infinity;
      const count = Math.min(overlap, outputLength - at);
      // Coarse search then sample-accurate refinement keeps long passages fast.
      const score = candidate => {
        let dot = 0, energy = 1e-12;
        for (let i = 0; i < count; i += 4) {
          const sample = input[candidate + i] || 0;
          dot += output[0][at + i] * sample;
          energy += sample * sample;
        }
        return dot / Math.sqrt(energy);
      };
      for (let candidate = low; candidate <= high; candidate += 8) {
        const value = score(candidate);
        if (value > best) { best = value; chosen = candidate; }
      }
      const coarse = chosen;
      for (let candidate = Math.max(low, coarse - 7); candidate <= Math.min(high, coarse + 7); candidate++) {
        const value = score(candidate);
        if (value > best) { best = value; chosen = candidate; }
      }
      for (let channel = 0; channel < channels.length; channel++) {
        const source = channels[channel];
        const target = output[channel];
        for (let i = 0; i < Math.min(frame, outputLength - at); i++) {
          const sample = source[chosen + i] || 0;
          const weight = Math.min(1, i / overlap);
          target[at + i] = i < overlap ? target[at + i] * (1 - weight) + sample * weight : sample;
        }
      }
    }
    return output;
  }
  const api = { stretch };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraTempo = api;
})(globalThis);
