# Third-party notices

The MIT license applies to Sonora's original application code. Dependencies and assets retain their own licenses.

- **Kokoro 82M:** downloaded separately from [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), pinned to revision `f3ff3571791e39611d31c381e3a41a3af07b4987`. The model is licensed under Apache-2.0. Its weights are not included in the source or release ZIP.
- **Python packages and tools:** the voice installer uses the versions in `tools/narration/requirements.lock`. See the installed packages and upstream projects for their individual licenses. uv and Python are separate prerequisites/downloads; their binaries are not bundled.
- **PDF.js and JSZip:** the optional browser book importer loads PDF.js 4.5.136 (Apache-2.0) and JSZip 3.10.1 (MIT or GPL-3.0) from public CDNs.
- **Moby-Dick sample:** `public/moby-dick.txt` comes from [Project Gutenberg ebook 2701](https://www.gutenberg.org/ebooks/2701), by Herman Melville. The file includes Project Gutenberg's distribution terms. The original work is public domain in the United States; check your jurisdiction if distributing it elsewhere.

Generated audio is synthetic narration. Users are responsible for having the rights to the text they convert and share.
