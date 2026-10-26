"""Build deterministic private training/plugin archives, no upload or install."""
import hashlib
import json
import zipfile
from pathlib import Path
from academy import doctor, sha256_file


def eligible(root):
    for p in sorted(root.rglob('*')):
        if not p.is_file() or {'dist', '__pycache__', '.git', '.venv', 'local-state'} & set(p.relative_to(root).parts):
            continue
        if p.suffix == '.pyc':
            continue
        if p.is_symlink():
            raise ValueError('SYMLINK_DENIED')
        yield p


def archive(source, target, prefix):
    names = []
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for p in eligible(source):
            name = prefix + '/' + p.relative_to(source).as_posix()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, p.read_bytes())
            names.append(name)
    with zipfile.ZipFile(target) as z:
        if z.testzip() is not None or z.namelist() != names:
            raise ValueError('ARCHIVE_VERIFICATION_FAILED')
        if len(names) != len(set(names)) or any('..' in Path(n).parts for n in names):
            raise ValueError('ARCHIVE_PATH_DENIED')
    return {'file': target.name, 'sha256': sha256_file(target), 'entries': len(names)}


def main():
    root = Path(__file__).resolve().parents[1]
    validation = doctor(root)
    if validation['errors']:
        raise ValueError('PACKAGE_STRUCTURE_INVALID:' + ','.join(validation['errors']))
    dist = root / 'dist'; dist.mkdir(exist_ok=True)
    files = {p.relative_to(root).as_posix(): sha256_file(p) for p in eligible(root)
             if p.name != 'MANIFEST.json'}
    (root / 'MANIFEST.json').write_text(json.dumps({'version': '0.1.0', 'files': files,
        'scope': 'Private education and offline validation, not live worker certification'}, indent=2) + '\n', encoding='utf-8')
    full = archive(root, dist / 'agy-muse-video-academy-0.1.0.zip', 'agy-muse-video-academy')
    plugin = archive(root / 'plugin', dist / 'agy-muse-video-academy-plugin-0.1.0.zip', 'agy-muse-video-academy')
    receipt = {'package_validation': validation, 'archives': [full, plugin],
               'source_file_count': len(files), 'installed': False, 'muse_training_delivered': False,
               'live_e2e': 'NOT_RUN'}
    (dist / 'RELEASE-RECEIPT.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
