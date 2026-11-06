(function (root) {
  // Serialized by scripting.executeScript: keep this function self-contained.
  function probeFrame() {
    const path = [];
    try {
      for (let view = window; view !== view.top && path.length < 16; view = view.parent) {
        let index = 0;
        while (index < view.parent.length && view.parent[index] !== view) index++;
        if (index === view.parent.length) return null;
        path.unshift(index);
      }
    } catch { return null; }
    const result = { path, url: location.href, score: 0, readable: false, frames: [] };
    // These readers already know how to find their content; never inspect their
    // subframes or walk a huge conversation before showing its controls.
    if (/^(chatgpt\.com|chat\.openai\.com)$/.test(location.hostname) && document.querySelector('[data-testid^="conversation-turn-"]')
      || location.hostname === 'docs.google.com' && location.pathname.startsWith('/document/') && document.querySelector('.kix-rotatingtilemanager')) {
      result.readable = true; result.score = 160; return result;
    }
    const noise = 'script,style,noscript,template,nav,header,footer,aside,form,button,input,textarea,select,[role="button"],[role="toolbar"],[role="navigation"],[role="menu"],[role="tooltip"],[hidden],[inert],[aria-hidden="true"],.sr-only,.visually-hidden,#sonora-overlay-root';
    const body = document.body || document.documentElement;
    if (!body) return result;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (node.matches(noise)) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(node);
        return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0'
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    // Sample only a bounded prefix, without textContent/innerText on a whole
    // answer and without geometry reads for each paragraph or syntax span.
    for (let visited = 0, node; visited < 512 && (node = walker.nextNode()); visited++) {
      if (node.nodeType === 3) result.score += node.data.slice(0, 256).replace(/\s+/g, ' ').trim().length;
      if (result.score >= 160) { result.readable = true; return result; }
    }
    for (const frame of document.querySelectorAll('iframe,frame')) {
      if (result.frames.length >= 64) break;
      if (frame.closest(noise) || !frame.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) continue;
      const rect = frame.getBoundingClientRect();
      const width = Math.min(innerWidth, rect.right) - Math.max(0, rect.left);
      const height = Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top);
      if (width < 32 || height < 32) continue;
      let index = 0;
      while (index < window.length && window[index] !== frame.contentWindow) index++;
      if (index === window.length) continue;
      const url = frame.hasAttribute('srcdoc') || !frame.src || frame.src === 'about:blank' ? location.href : frame.src;
      result.frames.push({path: [...path, index], url, area: width * height, sandbox: frame.getAttribute('sandbox')});
    }
    return result;
  }

  function candidates(top, results) {
    const byPath = new Map(results.filter(item => item.result?.path).map(item => [item.result.path.join('/'), item]));
    const visible = [];
    function visit(data, area = Infinity) {
      for (const frame of data?.frames || []) {
        const item = byPath.get(frame.path.join('/'));
        const candidate = { ...frame, area: Math.min(area, frame.area), frameId: item?.frameId, data: item?.result };
        visible.push(candidate);
        if (item) visit(item.result, candidate.area);
      }
    }
    visit(top);
    return visible.sort((a, b) => b.area - a.area || b.path.length - a.path.length);
  }

  function originPattern(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'blob:') return originPattern(url.origin);
      url.port = ''; // Chrome host permissions cover every port on the host.
      return /^https?:$/.test(url.protocol) ? url.origin + '/*' : null;
    } catch { return null; }
  }
  const api = { probeFrame, candidates, originPattern };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraFrames = api;
})(globalThis);
