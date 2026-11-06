(function (root) {
  function prepare(source) {
    const edits = [];
    for (const match of source.matchAll(/https?:\/\/[^\s<>]+/giu)) {
      const value = match[0].replace(/[.,;!?)]+$/u, '');
      let host = '';
      try {
        host = new URL(value).hostname.split('.').slice(-2).join('.');
      } catch {}
      const text = host && host.length <= 64 ? `Link to ${host}` : 'Link';
      edits.push({ start: match.index, end: match.index + value.length, text });
    }
    for (const match of source.matchAll(/[\p{L}\p{M}]+/gu)) {
      if (
        !/[^\p{Script=Latin}\p{M}]/u.test(match[0]) ||
        edits.some((edit) => match.index >= edit.start && match.index < edit.end)
      )
        continue;
      const previous = edits.at(-1);
      if (previous?.text === 'Unsupported language.' && /^\s*$/u.test(source.slice(previous.end, match.index)))
        previous.end = match.index + match[0].length;
      else edits.push({ start: match.index, end: match.index + match[0].length, text: 'Unsupported language.' });
    }
    edits.sort((a, b) => a.start - b.start);
    let text = '',
      cursor = 0;
    const segments = [];
    const append = (value, start, end, replacement = false) => {
      segments.push({ spokenStart: text.length, spokenEnd: text.length + value.length, start, end, replacement });
      text += value;
    };
    for (const edit of edits) {
      if (edit.start > cursor) append(source.slice(cursor, edit.start), cursor, edit.start);
      append(edit.text, edit.start, edit.end, true);
      cursor = edit.end;
    }
    if (cursor < source.length) append(source.slice(cursor), cursor, source.length);
    return { text, segments };
  }
  function mapWords(prepared, words) {
    if (!Array.isArray(words)) return [];
    return words.flatMap((word) => {
      const first = prepared.segments.find((segment) => segment.spokenEnd > word.textOffset);
      const last = prepared.segments.find((segment) => segment.spokenEnd >= word.textOffset + word.length);
      if (!first || !last) return [];
      if (first.replacement || last.replacement) return []; // Cues have no literal word to highlight in the source.
      const start = first.start + word.textOffset - first.spokenStart;
      const end = last.start + word.textOffset + word.length - last.spokenStart;
      return end > start ? [{ ...word, textOffset: start, length: end - start }] : [];
    });
  }
  function completePart(source, part, partial = false) {
    if (!part) return part;
    const end = part.offset + part.text.length;
    const url = [...part.text.matchAll(/https?:\/\/[^\s<>]+/giu)].at(-1);
    if (!url || url.index + url[0].length !== part.text.length) return part;
    if (end >= source.length) return { ...part, urlContinues: partial };
    if (/[\s<>]/u.test(source[end])) return part;
    const boundary = source.slice(end).search(/[\s<>]/u);
    return {
      ...part,
      text: source.slice(part.offset, boundary < 0 ? source.length : end + boundary),
      urlContinues: boundary < 0 && partial
    };
  }
  const api = { prepare, mapWords, completePart };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SonoraSpeech = api;
})(globalThis);
