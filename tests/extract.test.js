const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const config = require('../tools/narration/config');
test('ebook extraction follows EPUB spine order and handles text and PDF imports', { skip: !fs.existsSync(config.python) }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-extract-'));
  try {
    const output = execFileSync(config.python, ['-c', String.raw`
import sys
from pathlib import Path
from zipfile import ZipFile
sys.path.insert(0,sys.argv[1])
from extract import extract
root=Path(sys.argv[2])
book=root/'book.epub'
with ZipFile(book,'w') as archive:
 archive.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>')
 archive.writestr('OPS/package.opf','<package><manifest><item id="two" href="../chapters/two%20words.xhtml"/><item id="one" href="../chapters/one.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>')
 archive.writestr('chapters/one.xhtml','<html><head><title>Hidden title</title></head><body><nav>Hidden menu</nav><p>First readable chapter.</p><script>Hidden script</script></body></html>')
 archive.writestr('chapters/two words.xhtml','<html><body><p>Second readable chapter.</p></body></html>')
assert extract(book)=='First readable chapter.\n\nSecond readable chapter.'
for ext in ['txt','md']:
 p=root/('book.'+ext);p.write_text('\ufeffCall me Ishmael.');assert extract(p)=='Call me Ishmael.'
# A minimal text-bearing PDF exercises extraction without a visual fixture.
stream=b'BT /F1 12 Tf 72 720 Td (Call me Ishmael.) Tj ET'
objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream']
pdf=b'%PDF-1.4\n'; offsets=[0]
for i,obj in enumerate(objects,1):
 offsets.append(len(pdf));pdf+=str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
xref=len(pdf);pdf+=b'xref\n0 6\n0000000000 65535 f \n'
pdf+=b''.join(('%010d 00000 n \n'%offset).encode() for offset in offsets[1:])
pdf+=b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(xref).encode()+b'\n%%EOF'
p=root/'book.pdf';p.write_bytes(pdf);assert 'Call me Ishmael.' in extract(p)
from pypdf import PdfWriter
writer=PdfWriter();writer.add_blank_page(width=100,height=100)
p=root/'blank.pdf'
with p.open('wb') as file:writer.write(file)
try:extract(p);raise AssertionError('Blank PDF was accepted')
except ValueError as error:assert 'OCR' in str(error)
print('EPUB, TXT, MD, and selectable-text PDF imports passed; empty PDF rejected.')
`, path.join(__dirname, '../tools/books'), root], { encoding: 'utf8' });
    assert(output.includes('imports passed'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
