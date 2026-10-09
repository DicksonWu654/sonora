(function (root) {
  function surfaceFor(root) {
    if (!root) return null;
    const selector = '.kix-rotatingtilemanager';
    const surfaces = root.matches?.(selector) ? [root] : [...root.querySelectorAll(selector)];
    // Other document tabs retain their canvases, hidden inside the same editor.
    return surfaces.find(node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }) || null;
  }
  function passages(surface, cleanText) {
    if (!surface) return [];
    const origin = surface.getBoundingClientRect();
    const entries = [];
    const seen = new Map();
    const groups = [...surface.querySelectorAll('.kix-canvas-tile-text g[role="paragraph"], svg g[role="paragraph"]')];
    for (const node of groups) {
      const lines = [...node.querySelectorAll('rect[aria-label]')].map(rect => {
        const text = cleanText(rect.getAttribute('aria-label') || '');
        const bounds = rect.getBoundingClientRect();
        const x = bounds.left - origin.left;
        const y = bounds.top - origin.top;
        const key = `${Math.round(x)}|${Math.round(y)}|${text}`;
        return { rect, text, x, y, key, width: bounds.width, height: bounds.height };
      }).filter(line => line.text && line.width > 0 && line.height > 0 && !/^[●•◦▪‣]+$/.test(line.text));
      if (!lines.length) continue;
      // Canvas tiles overlap. Merge only copies at the same coordinates;
      // repeated paragraphs and identical table cells remain independent.
      let entry = lines.map(line => seen.get(line.key)).find(Boolean);
      if (!entry) { entry = { node, nodes: [], lines: [] }; entries.push(entry); }
      entry.nodes.push(node);
      for (const line of lines) {
        if (!seen.has(line.key)) { entry.lines.push(line); seen.set(line.key, entry); }
      }
    }
    for (const entry of entries) {
      entry.lines.sort((a, b) => Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y);
      entry.text = cleanText(entry.lines.map(line => line.text).join(' '));
      entry.rects = entry.nodes.flatMap(node => [...node.querySelectorAll('rect[aria-label]')]);
    }
    return entries.sort((a, b) => {
      const first = a.lines[0], second = b.lines[0];
      return Math.abs(first.y - second.y) < 2 ? first.x - second.x : first.y - second.y;
    }).map((entry, index) => ({ ...entry, index }));
  }
  function hitTest(entries, x, y) {
    return entries.find(entry => entry.rects.some(node => {
      const rect = node.getBoundingClientRect();
      return x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3;
    }));
  }
  function mergePassages(previous, current, cleanText) {
    // Docs recycles canvas tiles as the viewport moves. Keep the discovered
    // text, but release detached nodes and use only this frame's hit targets.
    const entries = previous.map(entry => ({
      ...entry, node: null, nodes: [], rects: [],
      lines: entry.lines.map(({ rect, ...line }) => line)
    }));
    const byLine = new Map();
    const byStart = new Map();
    const position = line => `${Math.round(line.x)}|${Math.round(line.y)}`;
    for (const entry of entries) {
      entry.lines.forEach(line => byLine.set(line.key, entry));
      byStart.set(position(entry.lines[0]), entry);
    }
    for (const incoming of current) {
      let entry = incoming.lines.map(line => byLine.get(line.key)).find(Boolean)
        || byStart.get(position(incoming.lines[0]));
      if (!entry) {
        entry = { key: incoming.lines[0].key, lines: [], nodes: [], rects: [] };
        entries.push(entry);
      }
      const oldLines = new Map(entry.lines.map(line => [position(line), line]));
      // A genuine text edit at the same position replaces the cached text.
      // Partial tile redraws merely add missing lines to the same paragraph.
      const edited = incoming.lines.some(line => {
        const old = oldLines.get(position(line));
        return old && old.text !== line.text;
      });
      if (edited) oldLines.clear();
      incoming.lines.forEach(({ rect, ...line }) => oldLines.set(position(line), line));
      entry.lines = [...oldLines.values()].sort((a, b) => Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y);
      entry.node ||= incoming.node;
      entry.nodes.push(...incoming.nodes);
      entry.rects.push(...incoming.rects);
      entry.lines.forEach(line => byLine.set(line.key, entry));
      byStart.set(position(entry.lines[0]), entry);
    }
    return entries.sort((a, b) => {
      const first = a.lines[0], second = b.lines[0];
      return Math.abs(first.y - second.y) < 2 ? first.x - second.x : first.y - second.y;
    }).map((entry, index) => ({ ...entry, index, text: cleanText(entry.lines.map(line => line.text).join(' ')) }));
  }
  const api = { surfaceFor, passages, hitTest, mergePassages };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraDocs = api;
})(globalThis);
