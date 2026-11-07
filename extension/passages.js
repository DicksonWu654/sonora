(function (root) {
  const editableSelector = '[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
  const textNoiseSelector = 'script,style,noscript,template,button,input,textarea,select,[role="button"],[role="toolbar"],[role="tooltip"],[hidden],[inert],[aria-hidden="true"],.sr-only,.visually-hidden,.reference,[role="doc-noteref"],a[href^="#cite_note"],' + editableSelector;
  const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const mathSelector = '.katex,.mwe-math-element,math,[role="math"],.mwe-math-fallback-image-inline,.mwe-math-fallback-image-display';
  const syntheticNodes = new WeakSet();
  const parentOf = node => node?.assignedSlot || node?.parentElement || node?.getRootNode?.().host || null;
  function contains(container, node) {
    if (!container || !node) return false;
    if (container === node || container.contains(node)) return true;
    for (let host = node.getRootNode?.().host; host; host = host.getRootNode?.().host) if (container === host || container.contains(host)) return true;
    return false;
  }
  function closest(node, selector) {
    for (let at = node; at; at = at.getRootNode?.().host) {
      const found = at.closest?.(selector);
      if (found) return found;
    }
    return null;
  }
  function compare(a, b) {
    if (a.getRootNode() === b.getRootNode()) return a.compareDocumentPosition(b);
    const ancestors = node => {
      const result = [];
      for (let at = node; at; at = parentOf(at)) result.unshift(at);
      return result;
    };
    const left = ancestors(a), right = ancestors(b);
    let at = 0;
    while (at < left.length && at < right.length && left[at] === right[at]) at++;
    if (at === left.length) return 4 | 16;
    if (at === right.length) return 2 | 8;
    return left[at].compareDocumentPosition(right[at]);
  }

  function visibleBlock(node, contained = false) {
    if (!node?.isConnected || closest(node, textNoiseSelector)) return false;
    for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
      if (parent.matches('details:not([open])') && !contains(parent.querySelector(':scope > summary'), node)) return false;
    }
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    for (let ancestor = parentOf(node); ancestor; ancestor = parentOf(ancestor)) {
      const parentStyle = node.ownerDocument.defaultView.getComputedStyle(ancestor);
      if (parentStyle.opacity === '0' || parentStyle.display === 'none') return false;
    }
    // Geometry queries materialize skipped content-visibility subtrees. ChatGPT
    // turns retain their readable DOM even while the browser skips rendering.
    if (contained) return style.display !== 'none';
    return [...node.getClientRects()].some(rect => rect.width > 1 && rect.height > 1);
  }

  function createTextReader(node, cleanText, endPoint = null) {
    syntheticNodes.delete(node);
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
      if (child.matches('details:not([open])')) {
        const summary = child.querySelector(':scope > summary');
        if (summary) yield* read(summary);
        return;
      }
      if (nestedList && child !== node && child.matches('ul,ol,menu')) return;
      const style = node.ownerDocument.defaultView.getComputedStyle(child);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return;
      if (child.matches(mathSelector)) { syntheticNodes.add(node); yield ' Equation. '; return; }
      if (child.matches('img')) {
        if (!child.closest('figure')?.querySelector('figcaption') && child.getAttribute('alt')?.trim()) { syntheticNodes.add(node); yield child.getAttribute('alt'); }
        return;
      }
      if (child.matches('br')) { yield '\n'; return; }
      const block = child !== node && /^(block|list-item|table-row|table-cell|flex|grid)$/.test(style.display);
      if (block) yield '\n';
      let index = 0;
      const assigned = child.localName === 'slot' ? child.assignedNodes({ flatten: true }) : null;
      const children = assigned?.length ? assigned : child.shadowRoot?.childNodes || child.childNodes;
      for (const at of children) {
        if (reachedEnd) break;
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

  const semanticSelector = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,caption,figcaption,summary,li,dt,dd,[role="cell"],[role="gridcell"]';
  const customSelector = '[data-block-id],[data-slate-node="element"],[data-lexical-node="true"],[data-testid*="paragraph" i],[role="heading"],[role="paragraph"],[role="article"],[role="listitem"]';
  const containerSelector = semanticSelector + ',' + customSelector + ',.commtext';
  const blockSelector = containerSelector + ',img[alt],' + mathSelector;

  // One traversal, with syntax spans and semantic block contents pruned. The
  // caller may stop between candidates instead of synchronously scanning a page.
  function* blockCandidates(root, noiseSelector, onShadow = null) {
    if (!root) return;
    const directText = [...root.childNodes].some(child => child.nodeType === 3 && /\S/u.test(child.data));
    if ((root.matches?.(blockSelector) && !root.matches('li,td,' + customSelector)) || directText && !root.querySelector(containerSelector)) { yield root; return; }
    const selectedLists = new WeakSet();
    const codeContainers = new WeakMap();
    const assigned = new WeakMap();
    const firstChild = node => {
      if (node.shadowRoot) { onShadow?.(node.shadowRoot); return node.shadowRoot.firstElementChild; }
      if (node.localName === 'slot') {
        const children = node.assignedElements({ flatten: true });
        if (children.length) { assigned.set(node, children); return children[0]; }
      }
      return node.firstElementChild;
    };
    const nextSibling = node => node.assignedSlot && assigned.has(node.assignedSlot)
      ? assigned.get(node.assignedSlot)[assigned.get(node.assignedSlot).indexOf(node) + 1] : node.nextElementSibling;
    let node = root;
    while (node) {
      let descend = true, candidate = false;
      if (node.matches(noiseSelector) || node.matches(textNoiseSelector)) descend = false;
      else if (node.matches(blockSelector)) {
        if (isCodeChrome(node, root, codeContainers)) descend = false;
        else if (node.matches('td,th') && node.querySelector('table,.commtext')) descend = true;
        // A selected list item already narrates its inline semantics and
        // captions. Still traverse wrappers to reach separate nested items.
        else if (!node.matches('li') && selectedLists.has(node.closest('li'))) descend = false;
        else {
          const nested = node.matches('li,dt,dd,blockquote,' + customSelector)
            && !node.matches('dt,dd,blockquote,.commtext') && node.querySelector(semanticSelector + ',' + customSelector);
          if (!nested || node.matches('li') && !node.querySelector('p,pre,blockquote')) { candidate = true; if (node.matches('li')) selectedLists.add(node); }
          descend = Boolean(nested) || node.matches('li');
        }
      } else if (node.matches('div,section,span,[role="text"],[aria-label]') && !node.closest('pre') && !selectedLists.has(node.closest('li'))) {
        const direct = [...node.childNodes].some(child => child.nodeType === 3 && /\S/u.test(child.data));
        if (direct && !node.querySelector(containerSelector) && !isCodeChrome(node, root, codeContainers)) { candidate = true; descend = false; }
        else if (!node.firstElementChild && node.getAttribute('aria-label')?.length > 0) candidate = true;
      }
      // A caller may yield between batches while React replaces this turn.
      const successors = [];
      const child = descend && firstChild(node);
      if (child) successors.push(child);
      for (let parent = node; parent && parent !== root; parent = parentOf(parent)) {
        const sibling = nextSibling(parent);
        if (sibling) successors.push(sibling);
      }
      if (candidate) yield node;
      node = successors.find(node => node.isConnected && contains(root, node)) || null;
    }
  }

  const genericScopes = new WeakMap();
  let genericScopeSequence = 0;
  function scopeNode(node) {
    return node.closest?.('[data-testid^="conversation-turn-"]') || node.closest?.('[data-message-id]')
      || node.closest?.('[data-block-id],[data-testid="user-message"],.font-claude-response');
  }
  function scopeFor(node) {
    const turn = node.closest('[data-testid^="conversation-turn-"]');
    if (turn) return `turn:${turn.getAttribute('data-testid')}`;
    const message = node.closest('[data-message-id]');
    if (message) return `message:${message.getAttribute('data-message-id')}`;
    const block = node.closest('[data-block-id]');
    if (block) return `block:${block.getAttribute('data-block-id')}`;
    const scope = scopeNode(node);
    if (!scope) return '';
    if (!genericScopes.has(scope)) genericScopes.set(scope, `scope:${++genericScopeSequence}`);
    return genericScopes.get(scope);
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
    return `${parsed.origin}${parsed.pathname}${chat ? '' : parsed.search}${/^#!?\//.test(parsed.hash) ? parsed.hash : ''}`;
  }

  // Filter before invalidating extraction/range caches. ChatGPT changes its UI
  // on every hover; those records do not alter the narration source.
  const chromeSelector = 'script,style,noscript,template,button,input,textarea,select,nav,aside,header,footer,form,[role="button"],[role="toolbar"],[role="tooltip"],[role="navigation"],[role="menu"],.sr-only,.visually-hidden,' + editableSelector;
  function contentMutations(records, overlayRoot, readableRoot) {
    const announcement = node => node.matches?.('[aria-live],[role="status"],time')
      && !node.closest('[data-message-id],[data-message-author-role],.markdown,.prose,pre,code')
      && !node.matches(blockSelector + ',[data-message-id],[data-testid^="conversation-turn-"],.markdown,.prose')
      && !node.querySelector(blockSelector + ',[data-message-id],[data-testid^="conversation-turn-"],.markdown,.prose');
    const meaningful = node => {
      const pending = [node];
      let visited = 0;
      while (pending.length) {
        const child = pending.pop();
        if (child === overlayRoot) continue;
        if (child.nodeType === 3) { if (child === node ? child.data.length : /\S/u.test(child.data)) return true; continue; }
        if (child.nodeType !== 1 || child.matches(chromeSelector + ',[hidden],[inert],[aria-hidden="true"]') || announcement(child)) continue;
        // Prune UI wrappers without serializing large message/code subtrees.
        if (child.matches(blockSelector + ',[data-message-id],[data-testid^="conversation-turn-"]') || child.getAttribute('aria-label')) return true;
        if (++visited > 64) return true;
        for (let at = child.lastChild; at; at = at.previousSibling) pending.push(at);
      }
      return false;
    };
    return [...records].filter(record => {
      const target = record.target?.nodeType === 3 ? record.target.parentElement : record.target;
      if (!target || overlayRoot?.contains(target)) return false;
      if (readableRoot?.isConnected && !contains(readableRoot, target)) return false;
      if (!readableRoot?.isConnected) return true; // The readable root was replaced.
      if (target.closest?.(chromeSelector)) return false;
      const live = target.closest?.('[aria-live],[role="status"],time');
      if (live && announcement(live)) return false;
      // Code headers and copy controls are siblings of the actual code text.
      const pre = target.closest?.('pre'), code = pre?.querySelector('code');
      if (code && target !== pre && !code.contains(target) && !target.contains(code)) return false;
      if (record.type === 'attributes') return true; // Including newly hidden prose.
      if (target.closest?.('[hidden],[inert],[aria-hidden="true"]')) return false;
      return record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(meaningful);
    });
  }

  function mutationScopes(records, overlayRoot = null, readableRoot = null) {
    const scopes = new Set();
    let full = false;
    if (!records || typeof records[Symbol.iterator] !== 'function') return { scopes, full: true };
    const scopeForNode = scopeNode;
    for (const record of records) {
      const target = record.target?.nodeType === 3 ? record.target.parentElement : record.target;
      if (!target || overlayRoot?.contains?.(target)) continue;
      if (readableRoot?.isConnected && !contains(readableRoot, target)) {
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

  const api = { contains, closest, parentOf, compare, syntheticText: node => syntheticNodes.has(node), editableSelector, textNoiseSelector, blockSelector, blockCandidates, visibleBlock, createTextReader, readableText, scopeFor, isCodeChrome, createReconciler, matchesPassage, pageIdentity, contentMutations, mutationScopes, nextPart, codePassages };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraPassages = api;
})(globalThis);
