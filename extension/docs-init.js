// Docs reads this at startup to expose its painted text as positioned SVG
// annotations. Keep another extension's annotation request if one exists.
globalThis._docs_annotate_canvas_by_ext ||= 'sonora';
