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
    // ASCII dominates prose/code. Segment only Unicode runs; Intl.Segmenter
    // over a whole answer is costly and allocates a record for every letter.
    for (let at = 0; at < text.length;) {
      if (text.charCodeAt(at) < 128 && (at + 1 === text.length || text.charCodeAt(at + 1) < 128)) {
        const char = text[at];
        if (!ignored.test(char)) { compact += char; positions.push({ start: at, end: at + 1 }); }
        at++;
        continue;
      }
      const from = at;
      do { at++; } while (at < text.length && text.charCodeAt(at) >= 128);
      for (const { segment, index } of segmenter.segment(text.slice(from, at))) {
        for (const char of segment.normalize('NFKC')) {
          if (ignored.test(char)) continue;
          compact += char;
          for (let i = 0; i < char.length; i++) positions.push({ start: from + index, end: from + index + segment.length });
        }
      }
    }
    return { text: compact, positions };
  }

  function compactSpan(map, start, length) {
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0) return null;
    let low = 0, high = map.positions.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (map.positions[middle].end <= start) low = middle + 1;
      else high = middle;
    }
    const first = low;
    if (!map.positions[first] || map.positions[first].start >= start + length) return null;
    high = map.positions.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (map.positions[middle].start < start + length) low = middle + 1;
      else high = middle;
    }
    const end = low;
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

  function domRange(index, span, document) {
    if (!span || !index.positions[span.start] || !index.positions[span.end - 1]) return null;
    const start = index.positions[span.start].start, end = index.positions[span.end - 1].end;
    const segmentAt = (offset, endPoint = false) => {
      let low = 0, high = index.segments.length;
      while (low < high) {
        const middle = (low + high) >> 1, segment = index.segments[middle];
        if (endPoint ? segment.end < offset : segment.end <= offset) low = middle + 1;
        else high = middle;
      }
      return index.segments[low];
    };
    const first = segmentAt(start), last = segmentAt(end, true);
    if (!first?.node.isConnected || !last?.node.isConnected) return null;
    try {
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      return range;
    } catch { return null; } // The page can replace text while an audio frame runs.
  }

  const compactString = text => String(text).normalize('NFKC').replace(/[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '');

  function createRangeResolver(document) {
    let saved = null, caretRead = null;
    const clean = root.BookText?.cleanText || (value => String(value).normalize('NFKC').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim());
    function mappingFor(entry) {
      if (entry.rangeMapping?.revision !== entry.domRevision || entry.rangeMapping?.prefixSafe === undefined) {
        const content = entry.contentNode || entry.node, raw = content.textContent;
        const text = clean(raw);
        entry.rangeMapping = { revision: entry.domRevision, safe: compactString(raw) === compactString(entry.text),
          prefixSafe: entry.partial ? text.startsWith(entry.text) : text === entry.text };
      }
      return entry.rangeMapping;
    }
    function indexed(entry) {
      const node = entry?.contentNode || entry?.node;
      if (!node?.isConnected) return null;
      const same = saved?.node === node;
      const unchanged = same && (entry.domRevision === undefined
        ? saved.segments.every(segment => segment.pieces.every(piece => piece.node.isConnected && piece.node.data === piece.value))
        : saved.revision === entry.domRevision);
      // Appends after the selected snapshot leave its DOM ranges valid.
      const appended = !unchanged && same && entry.text.startsWith(saved.text) && saved.segments.every(segment => segment.pieces.every(piece => piece.node.isConnected && piece.node.data.startsWith(piece.value)));
      if (!unchanged && !appended) saved = null;
      if (!saved) saved = { node, text: entry.text, revision: entry.domRevision, walker: document.createTreeWalker(node, 4), indexedLength: entry.text.length, segments: [], size: 0, styles: new WeakMap(), done: false, prefixOffset: 0, prefixSize: 0 };
      if (appended) { saved.revision = entry.domRevision; saved.text = entry.text; }
      return saved;
    }
    function anchorFor(entry) {
      const anchor = entry.rangeAnchor, content = entry.contentNode || entry.node;
      if (!anchor?.node.isConnected || !content.contains(anchor.node)) return null;
      if (anchor.revision !== entry.domRevision) {
        // Native prefix coordinates are safe only when filtering did not remove
        // any DOM text. Hidden controls retain the ordinary filtered walker.
        anchor.safe = mappingFor(entry).safe;
        if (anchor.safe) {
          const prefix = document.createRange(); prefix.selectNodeContents(content); prefix.setEnd(anchor.node, 0);
          anchor.offset = compactString(prefix.toString()).length;
        }
        anchor.revision = entry.domRevision;
      }
      return anchor.safe ? anchor : null;
    }
    function hidden(parent, data) {
      if (!parent || parent === data.node.parentElement) return false;
      if (data.styles.has(parent)) return data.styles.get(parent);
      const style = document.defaultView.getComputedStyle(parent);
      const value = style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0'
        || Boolean(parent.matches?.(root.SonoraPassages?.textNoiseSelector || 'script,style,noscript,template,button,input,textarea,select,[role="button"],[role="toolbar"],[role="tooltip"],[hidden],[inert],[aria-hidden="true"],.sr-only,.visually-hidden'))
        || hidden(parent.parentElement, data);
      data.styles.set(parent, value);
      return value;
    }
    function extend(data, end) {
      const started = performance.now();
      while (!data.done) {
        if (performance.now() - started > 2) break;
        let pending = data.pending;
        if (pending) data.pending = null;
        else {
          if (!data.walker.nextNode()) { data.done = true; break; }
          const node = data.walker.currentNode;
          if (hidden(node.parentElement, data)) continue;
          if (data.node.matches('li')) {
            const list = node.parentElement.closest('ul,ol,menu');
            if (list && data.node.contains(list)) continue;
          }
          pending = { node, value: node.data };
        }
        const { node, value } = pending, previous = data.segments.at(-1);
        const joins = previous && (/^[\p{M}\u200d\ufe00-\ufe0f\udc00-\udfff]/u.test(value) || /[\u200d\ud800-\udbff]$/u.test(previous.value));
        if (data.size >= end && !joins) { data.pending = pending; break; }
        const piece = { node, value, start: joins ? previous.value.length : 0 };
        if (joins) {
          previous.value += value; previous.pieces.push(piece); previous.window = null;
          previous.end = previous.start + compactString(previous.value).length;
          data.size = previous.end;
        } else {
          const size = compactString(value).length;
          if (size) data.segments.push({ node, value, pieces: [piece], start: data.size, end: data.size + size });
          data.size += size;
        }
        // Huge syntax trees advance across frames instead of blocking a click.
        if (performance.now() - started > 2) break;
      }
      return data.size >= end;
    }
    const resolve = (entry, start, length) => {
      resolve.pending = false;
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(length) || length <= 0) return null;
      let data = indexed(entry);
      if (!data) return null;
      if (start < data.prefixOffset) { data.prefixOffset = data.prefixSize = 0; }
      const from = data.prefixSize + compactString(entry.text.slice(data.prefixOffset, start)).length;
      const size = compactString(entry.text.slice(start, start + length)).length;
      const anchor = anchorFor(entry);
      if (data.segments[0]?.start > from || data.done && from + size > data.size && entry.text.length > data.indexedLength
        || anchor && anchor.offset <= from && anchor.offset > data.size + 1200) {
        saved = null; data = indexed(entry);
        if (anchor && anchor.offset <= from) {
          data.walker.currentNode = anchor.node;
          data.pending = { node: anchor.node, value: anchor.node.data };
          data.size = anchor.offset;
        }
      }
      data.prefixOffset = start; data.prefixSize = from;
      if (!size) return null;
      const complete = extend(data, from + size);
      // Keep a small look-behind window, plus the requested range. A reader
      // can traverse hours of code without retaining every visited DOM node.
      let discard = 0;
      while (discard < data.segments.length - 128 && data.segments[discard].end <= from) discard++;
      if (discard) { data.segments.splice(0, discard); data.styles = new WeakMap(); }
      if (!complete) { resolve.pending = !data.done; return null; }
      const at = offset => {
        let low = 0, high = data.segments.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (data.segments[middle].end <= offset) low = middle + 1;
          else high = middle;
        }
        return data.segments[low];
      };
      const first = at(from), last = at(from + size - 1);
      if (!first?.node.isConnected || !last?.node.isConnected) return null;
      // Only map the two text nodes containing the endpoints. For a 50,000-word
      // text node, use a bounded raw window around the desired compact offset.
      const point = (segment, compactOffset, endPoint) => {
        const target = compactOffset - segment.start;
        let raw = segment.window && target >= segment.window.counted ? segment.window.raw : 0;
        let counted = raw ? segment.window.counted : 0;
        // Native whitespace removal counts large ASCII prefixes cheaply.
        while (raw < segment.value.length) {
          let end = Math.min(segment.value.length, raw + 1024);
          while (end < segment.value.length && (/^[\p{M}\u200d\ufe00-\ufe0f\udc00-\udfff]/u.test(segment.value.slice(end)) || segment.value[end - 1] === '\u200d')) end++;
          const window = segment.value.slice(raw, end);
          const count = compactString(window).length;
          if (counted + count > target) break;
          raw += window.length; counted += count;
        }
        let end = Math.min(segment.value.length, raw + 1026);
        while (end < segment.value.length && (/^[\p{M}\u200d\ufe00-\ufe0f\udc00-\udfff]/u.test(segment.value.slice(end)) || segment.value[end - 1] === '\u200d')) end++;
        const cached = segment.window;
        const map = cached?.raw === raw ? cached.map : compactMap(segment.value.slice(raw, end));
        segment.window = { raw, counted, map };
        const position = map.positions[target - counted];
        if (!position) return null;
        const offset = raw + (endPoint ? position.end : position.start);
        const piece = segment.pieces.find(piece => endPoint ? offset <= piece.start + piece.value.length : offset < piece.start + piece.value.length) || segment.pieces.at(-1);
        return { node: piece.node, offset: offset - piece.start };
      };
      const firstOffset = point(first, from, false), lastOffset = point(last, from + size - 1, true);
      if (firstOffset === null || lastOffset === null) return null;
      try {
        const range = document.createRange();
        range.setStart(firstOffset.node, firstOffset.offset); range.setEnd(lastOffset.node, lastOffset.offset);
        return range;
      } catch { return null; }
    };
    resolve.offsetAt = (entry, x, y, position = null) => {
      resolve.caret = null;
      resolve.offsetPending = false;
      const caret = position || document.caretPositionFromPoint?.(x, y);
      const fallback = caret ? null : document.caretRangeFromPoint?.(x, y);
      const node = caret?.offsetNode || fallback?.startContainer;
      const offset = caret?.offset ?? fallback?.startOffset;
      const content = entry.contentNode || entry.node;
      if (!node || !content.contains(node)) return null;
      resolve.caret = { offsetNode: node, offset };
      // A native Range gives the prefix without walking/segmenting all code
      // lines. Keep end-of-line affinity, including indentation on the next line.
      const range = document.createRange();
      range.selectNodeContents(content); range.setEnd(node, offset);
      let prefix;
      if (mappingFor(entry).prefixSafe) { caretRead = null; prefix = range.toString(); }
      else {
        if (!caretRead || caretRead.content !== content || caretRead.node !== node || caretRead.offset !== offset || caretRead.revision !== entry.domRevision) {
          caretRead = { content, node, offset, revision: entry.domRevision,
            reader: root.SonoraPassages.createTextReader(content, value => value, { node, offset }) };
        }
        if (caretRead.reader) {
          const result = caretRead.reader.advance(2);
          if (!result.done) { resolve.offsetPending = true; return null; }
          caretRead.prefix = result.text; caretRead.reader = null;
        }
        prefix = caretRead.prefix;
      }
      // Start near the caret instead of materializing wrappers for every text
      // node preceding a deep code click or hover. Keep the whole visual line.
      if (node.nodeType === 3) {
        const walker = document.createTreeWalker(content, 4); walker.currentNode = node;
        let anchor = node, head = node.data.slice(0, offset), size = head.length;
        while (!/[\r\n]/.test(head) && size < 2400 && walker.previousNode()) {
          anchor = walker.currentNode; head = anchor.data; size += head.length;
        }
        entry.rangeAnchor = { node: anchor, revision: null, safe: false, offset: 0 };
      }
      let at = clean(prefix + '\ufffc').length - 1;
      if (offset > 0 && !/[\r\n]/.test(node.data?.slice(Math.max(0, offset - 1), offset) || '') && /\s/.test(entry.text[at] || '')) at--;
      return Math.max(0, Math.min(at, entry.partial ? Infinity : entry.text.length));
    };
    resolve.reset = () => { saved = caretRead = null; };
    return resolve;
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

  function clipFor(entry, document) {
    const window = document.defaultView;
    const clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (let node = entry?.contentNode || entry?.node; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      const x = /auto|scroll|hidden|clip/.test(style.overflowX), y = /auto|scroll|hidden|clip/.test(style.overflowY);
      if (x || y) {
        const rect = node.getBoundingClientRect();
        if (x) { clip.left = Math.max(clip.left, rect.left); clip.right = Math.min(clip.right, rect.right); }
        if (y) { clip.top = Math.max(clip.top, rect.top); clip.bottom = Math.min(clip.bottom, rect.bottom); }
      }
    }
    return clip;
  }

  function createTracker(document, container) {
    let words = [], spans = [], item = null, current = -1;
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
    const resolve = createRangeResolver(document);
    let lastNode = null, lastRevision, clip = null;
    function prepare(entry, passage, timings) {
      clearPaint(); item = passage; clip = null;
      const matched = entry && passage.blockOffset >= 0 && entry.text.slice(passage.blockOffset, passage.blockOffset + passage.text.length) === passage.text;
      words = matched && !entry.noWordTracking && Array.isArray(timings) ? timings.filter(word => word && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end > word.start
        && Number.isInteger(word.textOffset) && Number.isInteger(word.length) && word.textOffset >= 0 && word.length > 0 && word.textOffset + word.length <= passage.text.length).sort((a, b) => a.start - b.start) : [];
      if (entry?.rects) {
        const source = compactMap(entry.text);
        spans = words.map(word => compactSpan(source, passage.blockOffset + word.textOffset, word.length));
      } else if (words.length) {
        // Warm only the first word's range. Subsequent frames advance the index.
        resolve(entry, passage.blockOffset + words[0].textOffset, words[0].length);
      }
    }
    function update(entry, time, surface) {
      const next = wordAt(words, time);
      if (!entry || !item || entry.text.slice(item.blockOffset, item.blockOffset + item.text.length) !== item.text || next < 0) { clearPaint(); return; }
      const span = spans[next];
      if (entry.rects) {
        current = next;
        const editor = surface?.closest('.kix-appview-editor')?.getBoundingClientRect();
        const clip = { left: Math.max(0, editor?.left || 0), top: Math.max(0, editor?.top || 0), right: Math.min(window.innerWidth, editor?.right ?? window.innerWidth), bottom: Math.min(window.innerHeight, editor?.bottom ?? window.innerHeight) };
        paintBoxes(docsRects(entry, span, surface, context), clip);
      } else {
        const node = entry.contentNode || entry.node;
        const boxesNeeded = entry.useRectangles || entry.kind === 'code' || entry.text.length > 12000 || !registry || !Highlight;
        if (next === current && node === lastNode && entry.domRevision !== undefined && lastRevision === entry.domRevision && (!boxesNeeded || clip)) return;
        const word = words[next];
        const range = resolve(entry, item.blockOffset + word.textOffset, word.length);
        if (!range) { clearPaint(); return; }
        current = next; lastNode = node; lastRevision = entry.domRevision;
        if (!boxesNeeded) {
          while (boxes.length) boxes.pop().remove();
          const highlight = new Highlight(range); highlight.priority = 2;
          registry.set(highlightName, highlight);
        } else {
          registry?.delete(highlightName);
          if (!clip) clip = clipFor(entry, document);
          paintBoxes([...range.getClientRects()], clip);
        }
      }
    }
    function reset(release = false) { clearPaint(); words = []; spans = []; item = null; if (release) resolve.reset(); }

    return { prepare, update, reset, suspend: () => { clearPaint(); clip = null; }, invalidate: () => { clip = null; } };
  }

  const api = { compactMap, compactSpan, chunkOffsets, wordAt, domRange, createRangeResolver, docsRects, clipFor, createTracker };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraWords = api;
})(globalThis);
