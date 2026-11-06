function claudeHtml(count = 1000) {
  return (
    '<meta charset="utf-8"><title>Claude toolbar workload</title><style>p{margin:0;font:16px/24px sans-serif}</style><main><div role="toolbar"><button id="ui">Copy</button></div>' +
    Array.from(
      { length: count },
      (_, i) => `<div data-testid="user-message"><p>Message ${i} with a stable answer that has not changed.</p></div>`
    ).join('') +
    '</main>'
  );
}
module.exports = { claudeHtml };
