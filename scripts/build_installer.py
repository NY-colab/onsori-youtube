"""Build the Windows per-user installer with the OS-provided .NET compiler."""
from pathlib import Path
import hashlib
import subprocess
import sys
from PIL import Image
ROOT = Path(__file__).resolve().parents[1]

def main():
    subprocess.run([sys.executable, str(ROOT / 'scripts/package.py')], check=True)
    # Build files stay outside the packaged source directories.
    build = ROOT / 'runtime/installer-build'
    build.mkdir(parents=True, exist_ok=True)
    icon = build / 'onsori.ico'
    Image.open(ROOT / 'extension/icons/icon-128.png').save(icon, sizes=[(16,16),(32,32),(48,48),(64,64),(128,128)])
    manifest = build / 'installer.manifest'
    manifest.write_text('''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo>
</assembly>''', encoding='utf-8')
    output = ROOT.parent / 'OnSori-Setup.exe'
    subprocess.run([r'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe', '/nologo', '/target:winexe', '/platform:x64',
                    '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
                    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
                    '/win32manifest:' + str(manifest), '/win32icon:' + str(icon),
                    '/resource:' + str(ROOT.parent / 'OnSori-prototype-0.1.1.zip') + ',payload.zip',
                    '/out:' + str(output), str(ROOT / 'scripts/Installer.cs')], check=True)
    files = [output, ROOT.parent / 'OnSori-prototype-0.1.1.zip']
    (ROOT.parent / 'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in files), encoding='utf-8')
    print(str(output))

if __name__ == '__main__': main()
