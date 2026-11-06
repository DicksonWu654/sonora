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
    } catch {
      return null;
    }
    const result = {
      path,
      url: location.href,
      score: 0,
      readable: false,
      sample: 'empty',
      viewport: { width: innerWidth, height: innerHeight },
      frames: [],
      documents: []
    };
    if (
      document.contentType === 'application/pdf' ||
      document.body?.firstElementChild?.matches('embed[type="application/pdf"]')
    ) {
      result.pdf = true;
      return result;
    }
    // These readers already know their content; skip their text walks. Any
    // visible document frame is still offered through the explicit switch.
    if (
      (/^(chatgpt\.com|chat\.openai\.com)$/.test(location.hostname) &&
        document.querySelector('[data-testid^="conversation-turn-"]')) ||
      (location.hostname === 'docs.google.com' &&
        location.pathname.startsWith('/document/') &&
        document.querySelector('.kix-rotatingtilemanager'))
    ) {
      result.readable = true;
      result.score = 160;
      result.sample = 'readable';
    }
    const noise =
      'script,style,noscript,template,nav,header,footer,aside,form,button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="button"],[role="toolbar"],[role="navigation"],[role="menu"],[role="tooltip"],[hidden],[inert],[aria-hidden="true"],.sr-only,.visually-hidden,#sonora-overlay-root';
    const body = document.body || document.documentElement;
    if (!body) return result;
    const walker =
      !result.readable &&
      document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
          if (node.matches(noise)) return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(node);
          return style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse' ||
            style.opacity === '0'
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        }
      });
    // Sample only a bounded prefix, without textContent/innerText on a whole
    // answer and without geometry reads for each paragraph or syntax span.
    if (walker) {
      let visited = 0,
        node,
        truncated = false;
      while (visited < 512 && (node = walker.nextNode())) {
        visited++;
        if (node.nodeType === 3) {
          const value = node.data;
          const prefix = value.slice(0, 256).replace(/\s+/g, ' ').trim();
          if (/[\p{L}\p{N}]/u.test(prefix)) result.score += prefix.length;
          if (value.length > 256) truncated = true;
        }
        if (result.score >= 160) {
          result.readable = true;
          break;
        }
      }
      result.sample = result.readable
        ? 'readable'
        : result.score || visited >= 512 || truncated
          ? 'inconclusive'
          : 'empty';
    }
    // Ordinary articles and huge chats without subframes need no frame query.
    if (!window.length) return result;
    for (const frame of document.querySelectorAll('iframe,frame')) {
      if (result.documents.length >= 64) break;
      let index = 0;
      while (index < window.length && window[index] !== frame.contentWindow) index++;
      if (index === window.length) continue;
      // This is only an identity hint for matching browser navigation records,
      // never a permission target. Keep hidden siblings for that association.
      result.documents.push({
        path: [...path, index],
        sourceUrl: frame.hasAttribute('srcdoc') ? 'about:srcdoc' : frame.src || 'about:blank'
      });
      if (frame.closest(noise) || !frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const rect = frame.getBoundingClientRect();
      const scaleX = rect.width / (frame.offsetWidth || rect.width),
        scaleY = rect.height / (frame.offsetHeight || rect.height);
      const content = {
        left: rect.left + frame.clientLeft * scaleX,
        top: rect.top + frame.clientTop * scaleY,
        width: frame.clientWidth * scaleX,
        height: frame.clientHeight * scaleY
      };
      const clip = {
        left: Math.max(0, content.left),
        top: Math.max(0, content.top),
        right: Math.min(innerWidth, content.left + content.width),
        bottom: Math.min(innerHeight, content.top + content.height)
      };
      for (let parent = frame.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const paint = /paint|strict|content/.test(style.contain);
        const x = paint || style.overflowX !== 'visible',
          y = paint || style.overflowY !== 'visible';
        if (!x && !y) continue;
        const box = parent.getBoundingClientRect();
        const sx = box.width / (parent.offsetWidth || box.width || 1),
          sy = box.height / (parent.offsetHeight || box.height || 1);
        if (x) {
          clip.left = Math.max(clip.left, box.left + parent.clientLeft * sx);
          clip.right = Math.min(clip.right, box.left + (parent.clientLeft + parent.clientWidth) * sx);
        }
        if (y) {
          clip.top = Math.max(clip.top, box.top + parent.clientTop * sy);
          clip.bottom = Math.min(clip.bottom, box.top + (parent.clientTop + parent.clientHeight) * sy);
        }
      }
      const width = clip.right - clip.left,
        height = clip.bottom - clip.top;
      if (width < 32 || height < 32) continue;
      result.frames.push({
        path: [...path, index],
        clip,
        content,
        scaleX,
        scaleY,
        area: width * height,
        sandbox: frame.getAttribute('sandbox')
      });
    }
    return result;
  }

  function candidates(top, results, loaded = []) {
    const byPath = new Map(results.filter(item => item.result?.path).map(item => [item.result.path.join('/'), item]));
    const loadedPaths = new Map();
    const byId = new Map(loaded.map(item => [item.frameId, item]));
    const children = new Map();
    for (const item of loaded) {
      if (!children.has(item.parentFrameId)) children.set(item.parentFrameId, []);
      children.get(item.parentFrameId).push(item);
    }
    // Successful probes provide the browser's exact frame ID and path even
    // when a permitted frame was reparented or reordered since navigation.
    for (const [path, item] of byPath) {
      const metadata = byId.get(item.frameId);
      if (metadata) loadedPaths.set(path, metadata);
    }
    function associate(data) {
      const parentId = data === top ? 0 : byPath.get(data?.path?.join('/'))?.frameId;
      const browserFrames = children.get(parentId) || [];
      const documents = data?.documents || data?.frames || [];
      const used = new Set(
        documents.map(frame => byPath.get(frame.path.join('/'))?.frameId).filter(id => id !== undefined)
      );
      for (const frame of documents) {
        const key = frame.path.join('/');
        if (loadedPaths.has(key)) continue;
        const source = frame.sourceUrl || frame.url;
        if (!source || documents.filter(other => (other.sourceUrl || other.url) === source).length !== 1) continue;
        const matches = browserFrames.filter(item => !used.has(item.frameId) && item.url === source);
        if (matches.length === 1) {
          loadedPaths.set(key, matches[0]);
          used.add(matches[0].frameId);
        }
      }
      const unknown = documents.filter(
        frame => !byPath.has(frame.path.join('/')) && !loadedPaths.has(frame.path.join('/'))
      );
      const remaining = browserFrames.filter(item => !used.has(item.frameId));
      if (unknown.length === 1 && remaining.length === 1) loadedPaths.set(unknown[0].path.join('/'), remaining[0]);
      // Multiple unmatched redirects are ambiguous. Do not guess a host from
      // inventory order; a direct-open explanation is preferable to a bad grant.
    }
    const visible = [];
    function visit(data, ancestorClip = null, sx = 1, sy = 1, area = Infinity) {
      associate(data);
      for (const frame of data?.frames || []) {
        const item = byPath.get(frame.path.join('/'));
        const metadata = loadedPaths.get(frame.path.join('/'));
        let clip = frame.clip && { ...frame.clip };
        if (clip && ancestorClip) {
          clip.left = Math.max(clip.left, ancestorClip.left);
          clip.right = Math.min(clip.right, ancestorClip.right);
          clip.top = Math.max(clip.top, ancestorClip.top);
          clip.bottom = Math.min(clip.bottom, ancestorClip.bottom);
        }
        const exposed = clip
          ? Math.max(0, clip.right - clip.left) * Math.max(0, clip.bottom - clip.top) * sx * sy
          : Math.min(area, frame.area);
        if (!exposed) continue;
        const sameDocument = !item?.documentId || !metadata?.documentId || item.documentId === metadata.documentId;
        const candidate = {
          ...frame,
          clip,
          area: exposed,
          frameId: item?.frameId ?? metadata?.frameId,
          documentId: metadata?.documentId || item?.documentId,
          url: sameDocument ? item?.result?.url || metadata?.url : metadata?.url,
          data: sameDocument ? item?.result : null
        };
        visible.push(candidate);
        if (item) {
          const childClip =
            clip && frame.content
              ? {
                  left: (clip.left - frame.content.left) / frame.scaleX,
                  top: (clip.top - frame.content.top) / frame.scaleY,
                  right: (clip.right - frame.content.left) / frame.scaleX,
                  bottom: (clip.bottom - frame.content.top) / frame.scaleY
                }
              : null;
          visit(item.result, childClip, sx * (frame.scaleX || 1), sy * (frame.scaleY || 1), candidate.area);
        }
      }
    }
    visit(top);
    return visible.sort(
      (a, b) => Number(hasText(b.data)) - Number(hasText(a.data)) || b.area - a.area || b.path.length - a.path.length
    );
  }

  function hasText(data) {
    return Boolean(data?.readable || data?.score > 0);
  }
  function largeFrame(frame, top) {
    const viewport = top?.viewport;
    const threshold = viewport ? Math.min(120000, viewport.width * viewport.height * 0.2) : 120000;
    return (
      frame.area >= threshold &&
      (!frame.clip || frame.clip.right - frame.clip.left >= Math.min(320, viewport?.width * 0.8 || 320))
    );
  }

  function originPattern(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'blob:') return originPattern(url.origin);
      if (url.protocol === 'https:' && /(^|\.)frame\.claudeusercontent\.com$/.test(url.hostname))
        return 'https://*.frame.claudeusercontent.com/*';
      if (url.hostname.includes('*')) return null;
      url.port = ''; // Chrome host permissions cover every port on the host.
      return /^https?:$/.test(url.protocol) ? url.origin + '/*' : null;
    } catch {
      return null;
    }
  }
  const api = { probeFrame, candidates, originPattern, hasText, largeFrame };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraFrames = api;
})(globalThis);
