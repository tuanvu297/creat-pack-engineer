"""Verified, per-user installation; no network, key storage, or automatic updates.

MANIFEST.json inventories every regular package file except itself. The external
archive checksum must be obtained through a trusted owner/release channel; a
manifest provides integrity, not publisher authentication.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
import zipfile

MAX_BYTES = 100 * 1024 * 1024
MAX_FILES = 10000
MARKER = 'MANUS-KIT-INSTALL-v1'


class InstallError(Exception):
    pass


def _json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise InstallError('DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig'), object_pairs_hook=unique)
    except (ValueError, OSError) as exc:
        raise InstallError('INVALID_JSON') from exc


def _write(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    temp.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    os.replace(temp, path)


def _name(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise InstallError('UNSAFE_PATH')
    if value.startswith('/') or value.endswith('/'):
        raise InstallError('UNSAFE_PATH')
    parts = value.split('/')
    if any(p in ('', '.', '..') or p.endswith(('.', ' ')) or
           any(ord(c) < 32 or c in '<>"|?*' for c in p) or
           p.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *('COM'+str(n) for n in range(1,10)), *('LPT'+str(n) for n in range(1,10))}
           for p in parts):
        raise InstallError('UNSAFE_PATH')
    return PurePosixPath(value)


def _no_links(path):
    path = Path(path).absolute()
    for item in [path, *path.parents]:
        if item.exists() or item.is_symlink():
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise InstallError('LINK_OR_REPARSE_PATH')
    return path


def verify_package(root):
    root = _no_links(root)
    if not root.is_dir():
        raise InstallError('PACKAGE_DIRECTORY_REQUIRED')
    manifest_path = _no_links(root / 'MANIFEST.json')
    if not manifest_path.is_file() or manifest_path.stat().st_size > 4 * 1024 * 1024:
        raise InstallError('MANIFEST_REQUIRED_OR_TOO_LARGE')
    manifest = _json(manifest_path)
    if not isinstance(manifest, dict):
        raise InstallError('INVALID_MANIFEST_OBJECT')
    rows = manifest.get('files')
    if isinstance(rows, dict):
        rows = [{'path': key, 'sha256': value.get('sha256') if isinstance(value, dict) else value} for key,value in rows.items()]
    if not isinstance(rows, list) or not rows or len(rows) > MAX_FILES:
        raise InstallError('INVALID_MANIFEST_FILES')
    expected = {}
    folded = set()
    for row in rows:
        try:
            name = str(_name(row['path']))
            digest = row['sha256']
        except (TypeError, KeyError) as exc:
            raise InstallError('INVALID_MANIFEST_ENTRY') from exc
        if name.casefold() == 'manifest.json' or name.casefold() in folded or not isinstance(digest,str) or not re.fullmatch('[a-fA-F0-9]{64}', digest):
            raise InstallError('MANIFEST_COLLISION_OR_HASH')
        folded.add(name.casefold())
        expected[name] = digest.lower()
    found = set()
    all_names = set()
    total = 0
    for folder, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            item = _no_links(Path(folder) / name)
            rel = item.relative_to(root).as_posix()
            _name(rel)
            if rel.casefold() in all_names:
                raise InstallError('CASE_COLLISION')
            all_names.add(rel.casefold())
            info = item.lstat()
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise InstallError('NON_REGULAR_FILE')
            if item.is_file():
                if rel == 'MANIFEST.json':
                    continue
                total += info.st_size
                if total > MAX_BYTES:
                    raise InstallError('PACKAGE_TOO_LARGE')
                if rel not in expected:
                    raise InstallError('UNDECLARED_FILE')
                if hashlib.sha256(item.read_bytes()).hexdigest() != expected[rel]:
                    raise InstallError('FILE_HASH_MISMATCH')
                found.add(rel)
    if found != set(expected):
        raise InstallError('MISSING_DECLARED_FILE')
    version = manifest.get('package_version', manifest.get('version'))
    if not isinstance(version, str) or len(version) > 80:
        raise InstallError('PACKAGE_VERSION_REQUIRED')
    return {'status': 'PASS', 'version': version, 'files': len(found), 'bytes': total,
            'manifest': manifest, 'authenticity': 'EXTERNAL_TRUST_REQUIRED'}


def default_install_root(mode='ai'):
    if os.name == 'nt':
        return Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local')) / 'ManusConnectionKit' / mode
    return Path.home() / '.local' / 'share' / 'manus-connection-kit' / mode


def _managed(root, create=False):
    root = _no_links(root)
    if root == Path(root.anchor) or root == Path.home().absolute():
        raise InstallError('UNSAFE_INSTALL_ROOT')
    if not root.exists():
        if not create:
            raise InstallError('INSTALLATION_NOT_FOUND')
        root.mkdir(parents=True, mode=0o700)
    marker = root / '.manus-kit-install'
    if not marker.exists():
        if not create or any(root.iterdir()):
            raise InstallError('DESTINATION_NOT_OWNED')
        marker.write_text(MARKER, encoding='utf-8')
    _no_links(marker)
    if marker.read_text(encoding='utf-8') != MARKER:
        raise InstallError('DESTINATION_NOT_OWNED')
    # Managed children must never be redirected to another path.
    for folder, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            _no_links(Path(folder) / name)
    return root


@contextlib.contextmanager
def _lock(root):
    lock = root / '.install.lock'
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise InstallError('INSTALL_LOCKED: verify no installer is running before removing stale lock') from exc
    os.write(descriptor, str(os.getpid()).encode('ascii'))
    os.close(descriptor)
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def _python(executable=None):
    executable = str(_no_links(executable or sys.executable))
    result = subprocess.run([executable, '-I', '-c', 'import sys;print("%d.%d" % sys.version_info[:2]);sys.exit(sys.version_info < (3,10))'], capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise InstallError('PYTHON_3_10_OR_NEWER_REQUIRED')
    return executable


def self_test(package_root, python_executable=None):
    package_root = Path(package_root)
    verify_package(package_root)
    executable = _python(python_executable)
    # No auth/env values are printed or persisted. The packaged tests use fakes.
    env = {key: value for key,value in os.environ.items() if key not in ('MANUS_API_KEY', 'PYTHONPATH', 'PYTHONHOME')}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    result = subprocess.run([executable, '-B', '-m', 'unittest', 'discover', '-s', str(package_root / 'tests'), '-p', 'test*.py'], cwd=package_root, env=env, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise InstallError('OFFLINE_TEST_FAILED (no provider calls; installation not activated)')
    if not re.search(r'Ran [1-9][0-9]* tests? in', result.stderr):
        raise InstallError('NO_OFFLINE_TESTS_EXECUTED')
    return {'status': 'PASS', 'scope': 'packaged offline tests', 'summary': result.stderr.strip().splitlines()[-3:]}


def _remove_owned_child(root, child):
    child = _no_links(child)
    if root not in child.parents or child == root:
        raise InstallError('REMOVE_OUTSIDE_INSTALL_DENIED')
    if child.exists():
        shutil.rmtree(child)


def _copy_verified(source, destination):
    check = verify_package(source)
    destination.mkdir(mode=0o700)
    names = [entry['path'] for entry in check['manifest']['files']] if isinstance(check['manifest']['files'], list) else list(check['manifest']['files'])
    for name in [*names, 'MANIFEST.json']:
        path = _no_links(Path(source) / str(_name(name)))
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
    verify_package(destination)
    return check


def _recover(root):
    journal = root / 'install-transaction.json'
    if not journal.exists():
        return
    transaction = _json(journal)
    # Transaction IDs, not caller-supplied paths, identify managed children.
    token = transaction.get('token', '')
    if not re.fullmatch('[0-9a-f]{32}', token):
        raise InstallError('INVALID_TRANSACTION')
    stage = root / ('staging-' + token)
    previous = root / 'backups' / token
    current = root / 'current'
    if transaction.get('committed'):
        verify_package(current)
    else:
        if previous.exists():
            if current.exists():
                current.rename(root / ('failed-' + uuid.uuid4().hex))
            previous.rename(current)
        elif transaction.get('had_current') is False and current.exists():
            current.rename(root / ('failed-' + uuid.uuid4().hex))
        _remove_owned_child(root, stage)
        old_settings = transaction.get('old_settings')
        if isinstance(old_settings, dict):
            _write(root / 'installation.json', old_settings)
        elif transaction.get('had_current') is False:
            (root / 'installation.json').unlink(missing_ok=True)
    journal.unlink()


def install(package_root, install_root, python_executable=None):
    source = _no_links(package_root)
    root = _managed(install_root, create=True)
    if source == root or source in root.parents or root in source.parents:
        raise InstallError('SOURCE_AND_INSTALL_MUST_BE_SEPARATE')
    executable = _python(python_executable)
    with _lock(root):
        _recover(root)
        if (root / 'current').exists():
            raise InstallError('ALREADY_INSTALLED_USE_EXPLICIT_UPDATE')
        return _activate(source, root, executable)


def _activate(source, root, executable):
    token = uuid.uuid4().hex
    stage = root / ('staging-' + token)
    current = root / 'current'
    previous = root / 'backups' / token
    journal = root / 'install-transaction.json'
    try:
        check = _copy_verified(source, stage)
        precheck = self_test(stage, executable)
        had_current = current.exists()
        old_settings = _json(root / 'installation.json') if (root / 'installation.json').exists() else None
        transaction = {'token': token, 'had_current': had_current, 'committed': False, 'old_settings': old_settings}
        _write(journal, transaction)
        (root / 'backups').mkdir(exist_ok=True)
        if had_current:
            current.rename(previous)
        stage.rename(current)
        postcheck = self_test(current, executable)
        (root / 'state').mkdir(exist_ok=True, mode=0o700)
        settings = {'python': executable, 'state': str(root / 'state'), 'version': check['version']}
        _write(root / 'installation.json', settings)
        _write(journal, dict(transaction, committed=True))
        journal.unlink()
        return {'status': 'PASS', 'current': str(current), **settings, 'backup_id': token if had_current else None, 'precheck':precheck, 'postcheck':postcheck}
    except BaseException:
        if journal.exists():
            _recover(root)
        _remove_owned_child(root, stage)
        raise


def _version(value):
    match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)-(ai|human)\.(\d+)', value)
    if not match:
        raise InstallError('UNSUPPORTED_VERSION_FORMAT')
    return tuple(int(match[i]) for i in (1,2,3,5)), match[4]


def check_version(install_root, candidate_root=None):
    root = _managed(install_root)
    current = verify_package(root / 'current')['version']
    result = {'status': 'PASS', 'installed': current, 'network_requests': 0, 'automatic_update': False}
    if candidate_root:
        candidate = verify_package(candidate_root)['version']
        a, mode_a = _version(current)
        b, mode_b = _version(candidate)
        result.update(candidate=candidate, compatible=mode_a == mode_b, newer=mode_a == mode_b and b > a)
    return result


def extract_verified_zip(archive, expected_sha256, destination):
    archive = _no_links(archive)
    if not re.fullmatch('[0-9a-fA-F]{64}', expected_sha256 or ''):
        raise InstallError('TRUSTED_EXTERNAL_SHA256_REQUIRED')
    if archive.stat().st_size > MAX_BYTES:
        raise InstallError('ARCHIVE_TOO_LARGE')
    # Hash and parse identical immutable in-memory bytes to avoid swap races.
    blob = archive.read_bytes()
    if hashlib.sha256(blob).hexdigest() != expected_sha256.lower():
        raise InstallError('ARCHIVE_HASH_MISMATCH')
    import io
    destination = _no_links(destination)
    if not destination.is_dir() or any(destination.iterdir()):
        raise InstallError('EMPTY_EXTRACTION_DIRECTORY_REQUIRED')
    with zipfile.ZipFile(io.BytesIO(blob)) as source:
        infos = source.infolist()
        if len(infos) > MAX_FILES:
            raise InstallError('TOO_MANY_ARCHIVE_FILES')
        seen = set()
        total = 0
        for info in infos:
            # ZipInfo normalizes OS separators and truncates NULs. Validate its
            # original central-directory name before using any normalized path.
            raw_name = info.orig_filename
            if raw_name != info.filename:
                raise InstallError('UNSAFE_PATH_RAW_NAME_NORMALIZED')
            _name(raw_name[:-1] if raw_name.endswith('/') else raw_name)
            name = info.filename[:-1] if info.is_dir() else info.filename
            _name(name)
            if name.casefold() in seen:
                raise InstallError('ARCHIVE_CASE_COLLISION')
            seen.add(name.casefold())
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or (kind == stat.S_IFDIR) != info.is_dir() and kind:
                raise InstallError('ARCHIVE_LINK_OR_SPECIAL_FILE')
            total += info.file_size
            if total > MAX_BYTES or info.flag_bits & 1:
                raise InstallError('ARCHIVE_TOO_LARGE_OR_ENCRYPTED')
        for info in infos:
            target = destination / info.filename
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read(info))
    # Only one documented consumer wrapper layout is accepted.
    if {p.name for p in destination.iterdir()} != {'kit', 'START-HERE.md'}:
        raise InstallError('UNEXPECTED_ARCHIVE_ROOT')
    verify_package(destination / 'kit')
    return destination / 'kit'


def update(archive, expected_sha256, install_root, python_executable=None):
    root = _managed(install_root)
    with _lock(root):
        _recover(root)
        with tempfile.TemporaryDirectory(prefix='manus-update-') as temp:
            source = extract_verified_zip(archive, expected_sha256, temp)
            versions = check_version(root, source)
            if not versions['newer']:
                raise InstallError('UPDATE_MUST_BE_NEWER_AND_SAME_MODE')
            return _activate(source, root, _python(python_executable or _json(root / 'installation.json')['python']))


def rollback(install_root, backup_id=None):
    root = _managed(install_root)
    with _lock(root):
        _recover(root)
        backups = root / 'backups'
        choices = sorted((p for p in backups.iterdir() if p.is_dir()), key=lambda p:p.stat().st_mtime_ns) if backups.exists() else []
        if backup_id is not None and not re.fullmatch('[0-9a-f]{32}', backup_id):
            raise InstallError('INVALID_BACKUP_ID')
        selected = backups / backup_id if backup_id else choices[-1] if choices else None
        if selected is None or not selected.is_dir():
            raise InstallError('NO_BACKUP_AVAILABLE')
        executable = _json(root / 'installation.json')['python']
        return _activate(selected, root, _python(executable))


def uninstall(install_root):
    root = _managed(install_root)
    with _lock(root):
        _recover(root)
        # Preserve journal, credentials and all backups. Never delete user data.
        _remove_owned_child(root, root / 'current')
        (root / 'installation.json').unlink(missing_ok=True)
    return {'status':'PASS', 'application_removed':True, 'state_and_backups_preserved':True, 'path':str(root)}


def generate_mcp(install_root, output=None, grant_path=None):
    root = _managed(install_root)
    verify_package(root / 'current')
    settings = _json(root / 'installation.json')
    args = ['-B', str(root / 'current' / 'bin' / 'manus-kit.py'), '--state', settings['state']]
    if grant_path:
        args += ['--grant', str(Path(grant_path).absolute())]
    args += ['mcp']
    result = {'mcpServers': {'manus-kit': {'command': settings['python'], 'args': args}}}
    if output:
        output = _no_links(output)
        if output.exists():
            raise InstallError('CONFIG_OUTPUT_EXISTS_NO_OVERWRITE')
        output.parent.mkdir(parents=True, exist_ok=True)
        _write(output, result)
    return result


def auth_readiness():
    # Presence is not authentication. Never return the value or call provider.
    return {'status': 'READY_FOR_OWNER_AUTH_CHECK' if bool(os.environ.get('MANUS_API_KEY')) else 'BLOCKED',
            'environment_key_present': bool(os.environ.get('MANUS_API_KEY')), 'AUTH_VERIFIED': 'UNVERIFIED',
            'next_action': 'Use secure local Human launcher key entry or owner-managed client environment; never paste key into chat.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Verified Manus Kit installer; no automatic network or updates')
    parser.add_argument('--install-root', type=Path, default=default_install_root())
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('verify','install','self-test'):
        command = commands.add_parser(name)
        command.add_argument('--package', type=Path, default=Path(__file__).resolve().parents[1])
    command = commands.add_parser('check-version')
    command.add_argument('--candidate', type=Path)
    command = commands.add_parser('update')
    command.add_argument('--zip', type=Path, required=True)
    command.add_argument('--sha256', required=True)
    command = commands.add_parser('rollback')
    command.add_argument('--backup-id')
    commands.add_parser('uninstall')
    commands.add_parser('auth-readiness')
    command = commands.add_parser('mcp-config')
    command.add_argument('--output', type=Path)
    command.add_argument('--grant', type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == 'verify':
            result = verify_package(args.package)
            result.pop('manifest')
        elif args.command == 'install':result = install(args.package, args.install_root)
        elif args.command == 'self-test':result = self_test(args.package)
        elif args.command == 'check-version':result = check_version(args.install_root,args.candidate)
        elif args.command == 'update':result = update(args.zip,args.sha256,args.install_root)
        elif args.command == 'rollback':result = rollback(args.install_root,args.backup_id)
        elif args.command == 'uninstall':result = uninstall(args.install_root)
        elif args.command == 'auth-readiness':result = auth_readiness()
        else:result = generate_mcp(args.install_root,args.output,args.grant)
        print(json.dumps(result,indent=2))
        return 0
    except (InstallError, OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as exc:
        # Error text for OS/library exceptions can include paths, never secrets.
        print(json.dumps({'status':'BLOCKED','reason':str(exc) if isinstance(exc,InstallError) else type(exc).__name__}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
