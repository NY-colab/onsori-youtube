"""Build a source-only ZIP. Run with Python from any directory."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOP_FILES = ['README.md', 'CONTRACT.md', '.gitignore', 'requirements.txt',
             'requirements-caption.txt', 'Install-OnSori.cmd', 'Start-OnSori.cmd',
             'Install-Detail-Captions.cmd', 'Stop-OnSori.cmd']
SOURCE_DIRS = ['extension', 'web', 'server', 'scripts', 'tests', 'docs']
EXCLUDED = {'__pycache__', '.pytest_cache', 'node_modules', '.DS_Store'}

def main():
    paths = [ROOT / name for name in TOP_FILES]
    for name in SOURCE_DIRS:
        paths.extend(p for p in (ROOT / name).rglob('*') if p.is_file()
                     and not EXCLUDED.intersection(p.relative_to(ROOT).parts)
                     and p.suffix not in {'.pyc', '.pyo'})
    paths = sorted(paths, key=lambda p: p.relative_to(ROOT).as_posix())
    manifest = '\n'.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' +
                         p.relative_to(ROOT).as_posix() for p in paths) + '\n'
    destination = ROOT.parent / 'OnSori-prototype-0.1.0.zip'
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for p in paths:
            info = zipfile.ZipInfo('onsori/' + p.relative_to(ROOT).as_posix(), (2026,10,24,0,0,0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, p.read_bytes())
        archive.writestr('onsori/SOURCE-SHA256SUMS.txt', manifest)
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == len(paths) + 1
        for name in archive.namelist():
            assert not any(part in {'.venv', '.venv-caption', 'models', 'runtime', 'work'} for part in Path(name).parts)
        for line in manifest.splitlines():
            expected, relative = line.split('  ', 1)
            assert hashlib.sha256(archive.read('onsori/' + relative)).hexdigest() == expected
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix('.sha256').write_text(digest + '  ' + destination.name + '\n', encoding='utf-8')
    print(json.dumps({'zip':str(destination),'files':len(paths)+1,'bytes':destination.stat().st_size,'sha256':digest}))

if __name__ == '__main__':
    main()
