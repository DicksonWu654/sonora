(function (root) {
  function cleanText(text) {
    return String(text).toWellFormed().normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function chunksFor(text, limit = 1200) {
    if (!Number.isInteger(limit) || limit < 32) throw new Error('Invalid passage limit.');
    let rest = cleanText(text);
    const pieces = [];
    while (rest.length > limit) {
      const window = rest.slice(0, limit + 1);
      let cut = 0;
      // Prefer complete paragraphs and sentences, but always enforce a hard cap.
      for (const match of window.matchAll(/\n\n|[.!?…]["'”’)]*\s+/g)) {
        const end = match.index + match[0].length;
        if (end <= limit && end >= limit * .4) cut = end;
      }
      if (!cut) {
        for (const match of window.matchAll(/\s+/g)) {
          if (match.index > 0 && match.index <= limit) cut = match.index;
        }
      }
      if (!cut) cut = limit;
      // Never split a surrogate pair, even in a long word without whitespace.
      if (/[\ud800-\udbff]/.test(rest[cut - 1])) cut--;
      const piece = rest.slice(0, cut).trim();
      if (piece) pieces.push(piece);
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
    return pieces;
  }
  const api = { cleanText, chunksFor };
  if (typeof module !== 'undefined') module.exports = api;
  else root.BookText = api;
})(globalThis);
