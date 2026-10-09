(function (root) {
  const textNoiseSelector = 'script,style,noscript,template,button,input,textarea,select,[role="button"],[role="toolbar"],[role="tooltip"],[hidden],[inert],.sr-only,.visually-hidden';

  function visibleBlock(node) {
    if (!node?.isConnected || node.closest(textNoiseSelector)) return false;
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    return [...node.getClientRects()].some(rect => rect.width > 1 && rect.height > 1);
  }

  function readableText(node, cleanText) {
    if (!node) return '';
    if (!node.isConnected) return cleanText(node.textContent || '');
    const nestedList = node.matches('li') && node.querySelector('ul,ol,menu');
    if (!nestedList && !node.querySelector(textNoiseSelector)) {
      return cleanText(node.innerText || node.getAttribute('aria-label') || node.textContent || '');
    }
    // Read the live layout without replacing page markup. Toolbars and hidden
    // speaker labels can be nested inside an otherwise readable paragraph.
    const read = child => {
      if (child.nodeType === 3) return child.data;
      if (child.nodeType !== 1 || child.matches(textNoiseSelector)) return '';
      if (nestedList && child !== node && child.matches('ul,ol,menu')) return '';
      const style = node.ownerDocument.defaultView.getComputedStyle(child);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return '';
      if (child.matches('br')) return '\n';
      const text = [...child.childNodes].map(read).join('');
      return /^(block|list-item|table-row|table-cell|flex|grid)$/.test(style.display) ? `\n${text}\n` : text;
    };
    return cleanText(read(node));
  }

  function scopeFor(node) {
    const message = node.closest('[data-message-id]');
    if (message) return `message:${message.getAttribute('data-message-id')}`;
    const turn = node.closest('[data-testid^="conversation-turn-"]');
    if (turn) return `turn:${turn.getAttribute('data-testid')}`;
    const block = node.closest('[data-block-id]');
    return block ? `block:${block.getAttribute('data-block-id')}` : '';
  }

  function createReconciler() {
    let sequence = 0;
    const retained = new Map();
    return function reconcile(previous, incoming) {
      const byNode = new Map(previous.map(entry => [entry.node, entry]));
      const byText = new Map();
      const identity = entry => JSON.stringify([entry.scope || '', entry.text]);
      const previousKeys = new Set(previous.map(entry => entry.key));
      const candidates = [...previous, ...[...retained.values()].filter(entry => !previousKeys.has(entry.key))];
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
        if (result.scope) retained.set(result.key, { key: result.key, text: result.text, scope: result.scope });
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

  const api = { textNoiseSelector, visibleBlock, readableText, scopeFor, createReconciler, matchesPassage, pageIdentity };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraPassages = api;
})(globalThis);
