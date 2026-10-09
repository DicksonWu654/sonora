(function (root) {
  const highlightName = 'sonora-current-word';
  const ignored = /[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const lineMaps = new WeakMap();
  const rectangleMaps = new WeakMap();

  function cachedMap(cache, key, text) {
    let saved = cache.get(key);
    if (!saved || saved.raw !== text) {
      saved = { raw: text, map: compactMap(text) };
      cache.set(key, saved);
    }
    return saved.map;
  }

  function compactMap(value) {
    const text = String(value);
    let compact = '';
    const positions = [];
    for (const { segment, index } of segmenter.segment(text)) {
      for (const char of segment.normalize('NFKC')) {
        if (ignored.test(char)) continue;
        compact += char;
        for (let i = 0; i < char.length; i++) positions.push({ start: index, end: index + segment.length });
      }
    }
    return { text: compact, positions };
  }

  function compactSpan(map, start, length) {
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0) return null;
    const first = map.positions.findIndex(position => position.end > start);
    if (first < 0 || map.positions[first].start >= start + length) return null;
    let end = first;
    while (end < map.positions.length && map.positions[end].start < start + length) end++;
    return { start: first, end };
  }

  function chunkOffsets(text, chunks) {
    let cursor = 0;
    return chunks.map(chunk => {
      const offset = text.indexOf(chunk, cursor);
      if (offset >= 0) cursor = offset + chunk.length;
      return offset;
    });
  }

  function wordAt(words, time) {
    let low = 0, high = words.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (words[middle].start > time) high = middle - 1;
      else low = middle + 1;
    }
    return high >= 0 && time < words[high].end ? high : -1;
  }

  function domIndex(node, document) {
    const segments = [];
    let text = '';
    const walker = document.createTreeWalker(node, 4); // SHOW_TEXT
    while (walker.nextNode()) {
      const child = walker.currentNode, parent = child.parentElement;
      if (!parent || parent.closest('script,style,noscript')) continue;
      if (node.matches('li')) {
        const nestedList = parent.closest('ul,ol,menu');
        if (nestedList && node.contains(nestedList)) continue;
      }
      if (document.defaultView.getComputedStyle(parent).visibility === 'hidden') continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      if (![...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) continue;
      segments.push({ node: child, start: text.length, end: text.length + child.data.length });
      text += child.data;
    }
    return { ...compactMap(text), segments };
  }

  function domRange(index, span, document) {
    if (!span || !index.positions[span.start] || !index.positions[span.end - 1]) return null;
    const start = index.positions[span.start].start, end = index.positions[span.end - 1].end;
    const first = index.segments.find(segment => start >= segment.start && start < segment.end);
    const last = index.segments.find(segment => end > segment.start && end <= segment.end);
    if (!first?.node.isConnected || !last?.node.isConnected) return null;
    try {
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      return range;
    } catch { return null; } // The page can replace text while an audio frame runs.
  }

  function docsRects(entry, span, surface, context) {
    if (!span || !surface || !context) return [];
    const origin = surface.getBoundingClientRect();
    const result = [];
    let offset = 0;
    for (const line of entry.lines) {
      const lineMap = cachedMap(lineMaps, line, line.text);
      const size = lineMap.text.length;
      const start = Math.max(0, span.start - offset), end = Math.min(size, span.end - offset);
      offset += size;
      if (end <= start) continue;
      // Recycled tiles may expose only some lines. Match the live rectangle
      // by its document coordinates, keeping repeated words independent.
      const rect = entry.rects.find(node => {
        if (!node.isConnected) return false;
        const bounds = node.getBoundingClientRect();
        return Math.abs(bounds.left - origin.left - line.x) < 1.5 && Math.abs(bounds.top - origin.top - line.y) < 1.5
          && cachedMap(rectangleMaps, node, node.getAttribute('aria-label') || '').text === lineMap.text;
      });
      if (!rect) continue;
      const raw = rect.getAttribute('aria-label') || '', map = cachedMap(rectangleMaps, rect, raw);
      const first = map.positions[start], last = map.positions[end - 1];
      if (!first || !last) continue;
      context.font = rect.getAttribute('data-font-css') || '16px sans-serif';
      const total = context.measureText(raw).width;
      if (!total) continue;
      const bounds = rect.getBoundingClientRect(), scale = bounds.width / total;
      const before = context.measureText(raw.slice(0, first.start)).width * scale;
      const through = context.measureText(raw.slice(0, last.end)).width * scale;
      result.push({ left: bounds.left + before, top: bounds.top, width: through - before, height: bounds.height });
    }
    return result;
  }

  function createTracker(document, container) {
    let words = [], spans = [], item = null, index = null, sourceText = '', sourceBase = -1, current = -1;
    const boxes = [];
    const context = document.createElement('canvas').getContext('2d');
    const window = document.defaultView;
    const registry = window.CSS?.highlights;
    const Highlight = window.Highlight;

    function clearPaint() {
      registry?.delete(highlightName);
      boxes.forEach(box => box.remove());
      boxes.length = 0;
      current = -1;
    }
    function paintBoxes(rects, clip) {
      const visible = rects.map(rect => {
        const left = Math.max(rect.left, clip.left), top = Math.max(rect.top, clip.top);
        return { left, top, width: Math.min(rect.left + rect.width, clip.right) - left, height: Math.min(rect.top + rect.height, clip.bottom) - top };
      }).filter(rect => rect.width > 0 && rect.height > 0);
      while (boxes.length > visible.length) boxes.pop().remove();
      visible.forEach((rect, at) => {
        if (!boxes[at]) {
          const box = document.createElement('div');
          box.className = 'word-mark';
          box.setAttribute('aria-hidden', 'true');
          container.append(box);
          boxes.push(box);
        }
        Object.assign(boxes[at].style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        boxes[at].dataset.word = item.text.slice(words[current].textOffset, words[current].textOffset + words[current].length);
      });
    }
    function prepare(entry, passage, timings) {
      clearPaint();
      item = passage;
      index = null;
      sourceBase = -1;
      spans = [];
      sourceText = entry?.text || '';
      const matched = entry && passage.blockOffset >= 0 && sourceText.slice(passage.blockOffset, passage.blockOffset + passage.text.length) === passage.text;
      words = matched && Array.isArray(timings) ? timings.filter(word => word && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end > word.start
        && Number.isInteger(word.textOffset) && Number.isInteger(word.length) && word.textOffset >= 0 && word.length > 0 && word.textOffset + word.length <= passage.text.length).sort((a, b) => a.start - b.start) : [];
      if (!words.length) return;
      const source = compactMap(sourceText);
      spans = words.map(word => compactSpan(source, item.blockOffset + word.textOffset, word.length));
      if (!entry.rects && entry.node?.isConnected) {
        index = domIndex(entry.node, document);
        sourceBase = index.text.indexOf(source.text);
      }
    }
    function update(entry, time, surface) {
      const next = wordAt(words, time);
      if (!entry || entry.text !== sourceText || next < 0) { clearPaint(); return; }
      const span = spans[next];
      if (entry.rects) {
        current = next;
        const editor = surface?.closest('.kix-appview-editor')?.getBoundingClientRect();
        const clip = { left: Math.max(0, editor?.left || 0), top: Math.max(0, editor?.top || 0), right: Math.min(window.innerWidth, editor?.right ?? window.innerWidth), bottom: Math.min(window.innerHeight, editor?.bottom ?? window.innerHeight) };
        paintBoxes(docsRects(entry, span, surface, context), clip);
      } else if (index && sourceBase >= 0 && span) {
        if (registry && Highlight && next === current) return;
        const range = domRange(index, { start: sourceBase + span.start, end: sourceBase + span.end }, document);
        if (!range) { clearPaint(); return; }
        current = next;
        if (registry && Highlight) registry.set(highlightName, new Highlight(range));
        else paintBoxes([...range.getClientRects()], { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
      }
    }
    function reset() { clearPaint(); words = []; spans = []; item = index = null; sourceText = ''; sourceBase = -1; }
    return { prepare, update, reset };
  }

  const api = { compactMap, compactSpan, chunkOffsets, wordAt, domRange, docsRects, createTracker };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraWords = api;
})(globalThis);
