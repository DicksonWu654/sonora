"""Extract DRM-free ebooks in their reading order for the local conversion CLI."""
import json
import posixpath
import sys
from pathlib import Path
from urllib.parse import unquote
from zipfile import ZipFile
from xml.etree import ElementTree as ET


def extract(file):
    if file.suffix.lower() == '.pdf':
        from pypdf import PdfReader
        reader = PdfReader(file)
        if reader.is_encrypted and not reader.decrypt(''):
            raise ValueError('This PDF is encrypted. Supply an unlocked copy.')
        text = '\n\n'.join(page.extract_text() or '' for page in reader.pages)
        if not text.strip():
            raise ValueError('This PDF has no readable text. Run OCR first for scanned pages.')
        return text
    if file.suffix.lower() == '.epub':
        from bs4 import BeautifulSoup
        with ZipFile(file) as book:
            if sum(item.file_size for item in book.infolist()) > 256 * 1024 * 1024:
                raise ValueError('EPUB unpacked contents exceed 256 MB.')
            if 'META-INF/encryption.xml' in book.namelist():
                encryption = ET.fromstring(book.read('META-INF/encryption.xml'))
                methods = [node.get('Algorithm', '') for node in encryption.iter() if node.tag.split('}')[-1] == 'EncryptionMethod']
                if any(method not in ('http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC') for method in methods):
                    raise ValueError('This EPUB has encrypted content. Supply a DRM-free copy.')
            container = ET.fromstring(book.read('META-INF/container.xml'))
            rootfile = next(node.get('full-path') for node in container.iter() if node.tag.split('}')[-1] == 'rootfile')
            package = ET.fromstring(book.read(rootfile))
            manifest = {node.get('id'): node.get('href') for node in package.iter() if node.tag.split('}')[-1] == 'item'}
            passages = []
            for node in package.iter():
                if node.tag.split('}')[-1] != 'itemref' or node.get('linear') == 'no':
                    continue
                href = manifest[node.get('idref')]
                entry = posixpath.normpath(posixpath.join(posixpath.dirname(rootfile), unquote(href.split('#')[0])))
                document = BeautifulSoup(book.read(entry), 'html.parser')
                for hidden in document.select('script, style, nav, head'):
                    hidden.decompose()
                passages.append(document.get_text(' ', strip=True))
            return '\n\n'.join(passages)
    if file.suffix.lower() in ('.txt', '.md'):
        return file.read_text(encoding='utf-8-sig', errors='replace')
    raise ValueError('Supported ebook formats: PDF, EPUB, TXT, MD.')


if __name__ == '__main__':
    try:
        print(json.dumps({'text': extract(Path(sys.argv[1]))}, ensure_ascii=True))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
