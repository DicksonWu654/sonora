(function (root) {
  const textNoiseSelector = 'script,style,noscript,template,button,input,textarea,select,[role="button"],[role="toolbar"],[role="tooltip"],[hidden],[inert],[aria-hidden="true"],.sr-only,.visually-hidden';
  const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

  function visibleBlock(node) {
    if (!node?.isConnected || node.closest(textNoiseSelector)) return false;
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (node.ownerDocument.defaultView.getComputedStyle(ancestor).opacity === '0') return false;
    }
    return [...node.getClientRects()].some(rect => rect.width > 1 && rect.height > 1);
  }

  function createTextReader(node, cleanText, endPoint = null) {
    const parts = [];
    let size = 0, done = false, text = '', reachedEnd = false;
    const nestedList = node.matches('li') && node.querySelector('ul,ol,menu');
    function* read(child) {
      if (reachedEnd) return;
      if (child.nodeType === 3) {
        if (child === endPoint?.node) { reachedEnd = true; yield child.data.slice(0, endPoint.offset); }
        else yield child.data;
        return;
      }
      if (child.nodeType !== 1) return;
      yield ''; // Even empty/hidden syntax nodes must yield to the caller's budget.
      if (child.matches(textNoiseSelector)) return;
      if (nestedList && child !== node && child.matches('ul,ol,menu')) return;
      const style = node.ownerDocument.defaultView.getComputedStyle(child);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return;
      if (child.matches('br')) { yield '\n'; return; }
      const block = child !== node && /^(block|list-item|table-row|table-cell|flex|grid)$/.test(style.display);
      if (block) yield '\n';
      let index = 0;
      for (let at = child.firstChild; at && !reachedEnd; at = at.nextSibling) {
        if (child === endPoint?.node && index++ === endPoint.offset) { reachedEnd = true; break; }
        yield* read(at);
      }
      if (child === endPoint?.node) reachedEnd = true;
      if (block && !reachedEnd) yield '\n';
    }
    const iterator = read(node);
    return {
      advance(budget = Infinity, limit = Infinity) {
        const started = performance.now();
        while (!done && size < limit) {
          const next = iterator.next();
          if (next.done) { done = true; break; }
          const part = next.value.slice(0, Math.max(0, limit - size));
          if (part) parts.push(part); size += part.length;
          if (performance.now() - started >= budget) break;
        }
        if (done || size >= limit) {
          let value = parts.join('');
          // The next UTF-16 unit may complete a surrogate or extend the final
          // grapheme. Keep a stable prefix until full extraction replaces it.
          if (!done && value && size >= limit) value = value.slice(0, graphemes.segment(value).containing(value.length - 1).index);
          text = cleanText(endPoint ? value : value || node.getAttribute('aria-label') || '');
        }
        return { done, text, size };
      }
    };
  }

  function readableText(node, cleanText, limit = Infinity) {
    if (!node) return '';
    if (!node.isConnected) return cleanText((node.textContent || '').slice(0, limit));
    return createTextReader(node, cleanText).advance(Infinity, limit).text;
  }

  const semanticSelector = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,caption,li,dt,dd,[role="cell"],[role="gridcell"]';
  const customSelector = '[data-block-id],[data-slate-node="element"],[data-lexical-node="true"],[data-testid*="paragraph" i],[role="heading"],[role="paragraph"],[role="article"],[role="listitem"]';
  const blockSelector = semanticSelector + ',' + customSelector;

  // One traversal, with syntax spans and semantic block contents pruned. The
  // caller may stop between candidates instead of synchronously scanning a page.
  function* blockCandidates(root, noiseSelector) {
    if (!root) return;
    const directText = [...root.childNodes].some(child => child.nodeType === 3 && /\S.{1}/u.test(child.data));
    if ((root.matches?.(blockSelector) && !root.matches('li,dt,dd,blockquote,' + customSelector)) || directText && !root.querySelector(blockSelector)) { yield root; return; }
    const selectedLists = new WeakSet();
    const codeContainers = new WeakMap();
    let node = root;
    while (node) {
      let descend = true, candidate = false;
      if (node.matches(noiseSelector) || node.matches(textNoiseSelector)) descend = false;
      else if (node.matches(blockSelector)) {
        if (isCodeChrome(node, root, codeContainers)) descend = false;
        else {
          const nested = node.matches('li,dt,dd,blockquote,' + customSelector)
            && node.querySelector(semanticSelector + ',' + customSelector);
          if (!nested || node.matches('li') && !node.querySelector('p,pre,blockquote')) { candidate = true; if (node.matches('li')) selectedLists.add(node); }
          descend = Boolean(nested) || node.matches('li');
        }
      } else if (node.matches('div,section,span,[role="text"],[aria-label]') && !node.closest('pre') && !selectedLists.has(node.closest('li'))) {
        const direct = [...node.childNodes].some(child => child.nodeType === 3 && /\S.{1}/u.test(child.data));
        if (direct && !node.querySelector(blockSelector) && !isCodeChrome(node, root, codeContainers)) { candidate = true; descend = false; }
        else if (!node.firstElementChild && node.getAttribute('aria-label')?.length > 1) candidate = true;
      }
      // A caller may yield between batches while React replaces this turn.
      const successors = [];
      if (descend && node.firstElementChild) successors.push(node.firstElementChild);
      for (let parent = node; parent && parent !== root; parent = parent.parentElement) {
        if (parent.nextElementSibling) successors.push(parent.nextElementSibling);
      }
      if (candidate) yield node;
      node = successors.find(node => node.isConnected && root.contains(node)) || null;
    }
  }

  function scopeFor(node) {
    const turn = node.closest('[data-testid^="conversation-turn-"]');
    if (turn) return `turn:${turn.getAttribute('data-testid')}`;
    const message = node.closest('[data-message-id]');
    if (message) return `message:${message.getAttribute('data-message-id')}`;
    const block = node.closest('[data-block-id]');
    return block ? `block:${block.getAttribute('data-block-id')}` : '';
  }

  function isCodeChrome(node, root, containers = null) {
    for (let container = node.parentElement; container && container !== root; container = container.parentElement) {
      if (container.matches('article,main,[data-message-id],[data-testid^="conversation-turn-"]')) return false;
      let pre;
      if (containers?.has(container)) pre = containers.get(container);
      else {
        pre = container.querySelector('pre');
        containers?.set(container, pre);
      }
      if (!pre) continue;
      if (pre.contains(node) || node.contains(pre)) return false;
      const prose = [...container.querySelectorAll('p,h1,h2,h3,h4,h5,h6,blockquote,li,td,th,dt,dd')]
        .some(other => !pre.contains(other) && !node.contains(other) && !other.contains(node));
      // Language labels and copy controls share a small container with one
      // code box. Do not classify the surrounding message/article as chrome.
      return !prose && container.querySelectorAll('pre').length === 1
        && Boolean(container.querySelector('button,[role="button"],[role="toolbar"]'));
    }
    return false;
  }

  function createReconciler() {
    let sequence = 0;
    const retained = new Map(), retainedByScope = new Map();
    const RETAINED_LIMIT = 1200, RETAINED_CHAR_LIMIT = 2000000;
    let retainedCharacters = 0;
    function forget(key) {
      const entry = retained.get(key);
      if (!entry) return;
      retainedCharacters -= entry.text.length || 0;
      retained.delete(key);
      const scope = retainedByScope.get(entry.scope);
      scope?.delete(key);
      if (!scope?.size) retainedByScope.delete(entry.scope);
    }
    return function reconcile(previous, incoming) {
      const byNode = new Map(previous.map(entry => [entry.node, entry]));
      const byText = new Map();
      const identity = entry => JSON.stringify([entry.scope || '', entry.text]);
      const previousKeys = new Set(previous.map(entry => entry.key));
      const scopes = new Set([...previous, ...incoming].map(entry => entry.scope || ''));
      const remembered = [...scopes].flatMap(scope => [...(retainedByScope.get(scope)?.values() || [])]);
      const candidates = [...previous, ...remembered.filter(entry => !previousKeys.has(entry.key))];
      for (const entry of candidates) {
        const id = identity(entry);
        if (!byText.has(id)) byText.set(id, []);
        byText.get(id).push(entry);
      }
      const used = new Set();
      // Reserve surviving DOM nodes first. Inserting an identical paragraph
      // before an existing one must not steal that paragraph's queue key.
      const matched = incoming.map(entry => {
        const old = byNode.get(entry.node);
        if (!old || (old.scope || '') !== (entry.scope || '')) return null;
        used.add(old.key);
        return old;
      });
      return incoming.map((entry, index) => {
        const old = matched[index] || byText.get(identity(entry))?.find(candidate => !used.has(candidate.key));
        if (old) used.add(old.key);
        const result = { ...entry, index, key: old?.key || `page-${++sequence}` };
        // Virtualized message text can return in a later frame. Retain its
        // identity without keeping detached DOM nodes alive.
        if (result.scope) {
          forget(result.key);
          const remembered = { key: result.key, text: result.text, scope: result.scope };
          retained.set(result.key, remembered);
          if (!retainedByScope.has(result.scope)) retainedByScope.set(result.scope, new Map());
          retainedByScope.get(result.scope).set(result.key, remembered);
          retainedCharacters += result.text.length || 0;
          while (retained.size > RETAINED_LIMIT || retainedCharacters > RETAINED_CHAR_LIMIT) forget(retained.keys().next().value);
        }
        return result;
      });
    };
  }

  function matchesPassage(entry, passage) {
    return Boolean(entry && passage && Number.isInteger(passage.blockOffset) && passage.blockOffset >= 0
      && entry.text.slice(passage.blockOffset, passage.blockOffset + passage.text.length) === passage.text);
  }

  function pageIdentity(url) {
    const parsed = new URL(url);
    const chat = /^(chatgpt\.com|chat\.openai\.com)$/i.test(parsed.hostname);
    return `${parsed.origin}${parsed.pathname}${chat ? '' : parsed.search}`;
  }

  function mutationScopes(records, overlayRoot = null, readableRoot = null) {
    const scopes = new Set();
    let full = false;
    if (!records || typeof records[Symbol.iterator] !== 'function') return { scopes, full: true };
    const scopeForNode = node => node.closest?.('[data-testid^="conversation-turn-"]') || node.closest?.('[data-message-id]');
    for (const record of records) {
      const target = record.target?.nodeType === 3 ? record.target.parentElement : record.target;
      if (!target || overlayRoot?.contains?.(target)) continue;
      if (readableRoot?.isConnected && !readableRoot.contains(target)) {
        if (target.contains?.(readableRoot) && [...(record.removedNodes || [])].some(node => node.contains?.(readableRoot))) full = true;
        continue;
      }
      const scope = scopeForNode(target);
      if (scope) { scopes.add(scope); continue; }
      let changed = false;
      for (const node of [...(record.addedNodes || []), ...(record.removedNodes || [])]) {
        if (node === overlayRoot) continue;
        changed = true;
        if (node.nodeType !== 1) { full = true; continue; }
        const ownScope = scopeForNode(node);
        if (ownScope) scopes.add(ownScope);
        else full = true; // Initial discovery also accepts prose outside turns.
      }
      if (!changed && record.type !== 'childList') full = true;
      if (readableRoot && !readableRoot.isConnected) full = true;
    }
    return { scopes, full };
  }

  function nextPart(text, offset, code, chunksFor, openingChunksFor = null) {
    let cursor = offset;
    while (cursor < text.length) {
      while (cursor < text.length && /\s/u.test(text[cursor])) cursor++;
      if (cursor >= text.length) return null;
      const window = text.slice(cursor, cursor + (code ? 2400 : 1201));
      const part = code ? codePassages(window, chunksFor)[0] : { text: chunksFor(window, 1200)[0], offset: 0 };
      if (!part?.text) { cursor += window.length; continue; }
      const value = openingChunksFor ? openingChunksFor(part.text)[0] : part.text;
      return { text: value, offset: cursor + (part.offset || 0) };
    }
    return null;
  }

  function codePassages(text, chunksFor, limit = 1200) {
    const parts = [];
    let cursor = 0, prefix = null;
    for (const line of text.split('\n')) {
      const value = line.trim(), start = cursor + line.indexOf(value);
      cursor += line.length + 1;
      if (!value) continue;
      let at = 0;
      for (const chunk of chunksFor(value, limit)) {
        const offset = start + value.indexOf(chunk, at);
        at = offset - start + chunk.length;
        const end = offset + chunk.length;
        // Braces, separators and fences alone have no speech. Keep them with
        // a neighboring readable line instead of asking the voice for silence.
        if (!/[\p{L}\p{N}]/u.test(chunk)) {
          const previous = parts.at(-1);
          if (previous && end - previous.offset <= limit) previous.text = text.slice(previous.offset, end);
          else if (!previous && prefix === null) prefix = offset;
          continue;
        }
        if (prefix !== null && end - prefix > limit) {
          const value = text.slice(prefix, end);
          let cursor = prefix;
          for (const part of chunksFor(value, limit)) {
            cursor = text.indexOf(part, cursor);
            parts.push({ text: part, offset: cursor }); cursor += part.length;
          }
          prefix = null;
          continue;
        }
        const from = prefix !== null ? prefix : offset;
        parts.push({ text: text.slice(from, end), offset: from });
        prefix = null;
      }
    }
    return parts;
  }

  const api = { textNoiseSelector, blockSelector, blockCandidates, visibleBlock, createTextReader, readableText, scopeFor, isCodeChrome, createReconciler, matchesPassage, pageIdentity, mutationScopes, nextPart, codePassages };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraPassages = api;
})(globalThis);
