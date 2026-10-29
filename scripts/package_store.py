"""Build only the browser extension, with manifest.json at ZIP root.

Run scripts/build_browser.mjs first. This never packages the local Python app,
recordings, model caches, tests, development profiles or credentials.
"""
from pathlib import Path
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / 'extension'
OUTPUT = ROOT.parent / 'onsori-webstore'
ALLOWED = {'.js', '.mjs', '.html', '.css', '.png', '.ico', '.wasm', '.json', '.txt', '.md'}

def main():
    manifest = json.loads((EXTENSION / 'manifest.json').read_text('utf-8'))
    assert manifest['manifest_version'] == 3
    assert manifest['version'] == '0.3.3'
    assert set(manifest['permissions']) == {'storage', 'activeTab', 'tabCapture', 'offscreen'}
    assert len(manifest['description']) <= 132
    assert not any('127.0.0.1' in x or '<all_urls>' in x for x in manifest['host_permissions'])
    assert (EXTENSION / 'vendor').is_dir(), 'Run node scripts/build_browser.mjs first'
    vendor = json.loads((EXTENSION / 'vendor/build-manifest.json').read_text('utf-8'))
    assert vendor['lockfile_sha256'] == hashlib.sha256((ROOT / 'browser-build/package-lock.json').read_bytes()).hexdigest()
    for entry in vendor['files']:
        payload = (EXTENSION / 'vendor' / entry['path']).read_bytes()
        assert len(payload) == entry['size'] and hashlib.sha256(payload).hexdigest() == entry['sha256'], entry['path']
    paths = sorted(p for p in EXTENSION.rglob('*') if p.is_file()
                   and p.suffix in ALLOWED and '.test.' not in p.name
                   and p.name not in {'package.json', 'package-lock.json'}
                   and not any(x in p.parts for x in ('node_modules', '__pycache__')))
    for p in paths:
        if p.parent == EXTENSION and p.suffix == '.js':
            source = p.read_text('utf-8')
            assert 'http://127.0.0.1:8765' not in source, f'Local server dependency: {p.name}'
            assert not re.search(r'(?:eval\s*\(|new\s+Function\s*\()', source), p.name
    required = ['worker.js', 'offscreen.js', 'browser-engine.js', 'browser-inference-worker.js',
                'help.html', 'privacy.html', 'icons/icon-128.png']
    assert all((EXTENSION / p).is_file() for p in required), 'Incomplete browser build'
    OUTPUT.mkdir(exist_ok=True)
    target = OUTPUT / f'OnSori-Chrome-WebStore-{manifest["version"]}.zip'
    files = {p.relative_to(EXTENSION).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in paths:
            info = zipfile.ZipInfo(p.relative_to(EXTENSION).as_posix(), (2026, 10, 25, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, p.read_bytes())
    with zipfile.ZipFile(target) as z:
        assert z.testzip() is None
        assert 'manifest.json' in z.namelist()
        for name, digest in files.items():
            assert hashlib.sha256(z.read(name)).hexdigest() == digest, name
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    (OUTPUT / 'SHA256SUMS.txt').write_text(f'{digest}  {target.name}\n', encoding='utf-8')
    (OUTPUT / 'package-verification.json').write_text(json.dumps({
        'version': manifest['version'], 'zip': target.name, 'bytes': target.stat().st_size,
        'sha256': digest, 'files': files, 'web_store_status': 'not_submitted',
        'note': 'Packaging verification only. Store approval and runtime verification are separate.'
    }, indent=2), encoding='utf-8')
    print(json.dumps({'zip': str(target), 'bytes': target.stat().st_size, 'sha256': digest, 'files': len(files)}))

if __name__ == '__main__':
    main()
