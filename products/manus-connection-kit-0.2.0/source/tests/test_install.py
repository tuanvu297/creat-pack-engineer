"""Installer boundary tests. Fixtures contain one harmless offline test."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import kit_install as ki


def fixture(root, version='0.2.0-ai.1', broken=False):
    root.mkdir(parents=True)
    (root / 'tests').mkdir()
    (root / 'bin').mkdir()
    (root / 'bin' / 'manus-kit.py').write_text('print("offline fixture")\n', encoding='utf-8')
    (root / 'tests' / 'test_safe.py').write_text('import unittest\nclass Safe(unittest.TestCase):\n def test_safe(self): self.assertTrue('+str(not broken)+')\n', encoding='utf-8')
    manifest = {'package_version':version, 'files':[]}
    for path in sorted(root.rglob('*')):
        if path.is_file():
            manifest['files'].append({'path':path.relative_to(root).as_posix(),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    (root / 'MANIFEST.json').write_text(json.dumps(manifest),encoding='utf-8')
    return root


def archive(root, output):
    with zipfile.ZipFile(output,'w') as z:
        z.writestr('START-HERE.md','fixture\n')
        for path in root.rglob('*'):
            if path.is_file():z.write(path, 'kit/' + path.relative_to(root).as_posix())
    return hashlib.sha256(output.read_bytes()).hexdigest()


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='manus-install-test-')
        self.base = Path(self.temp.name)
        self.source = fixture(self.base / 'source')
        self.target = self.base / 'installed'

    def tearDown(self):self.temp.cleanup()

    def test_verify_tamper_missing_extra_and_case_collision(self):
        self.assertEqual(ki.verify_package(self.source)['status'],'PASS')
        file = self.source/'bin'/'manus-kit.py'
        original = file.read_bytes()
        file.write_bytes(b'tampered')
        with self.assertRaisesRegex(ki.InstallError,'HASH'):ki.verify_package(self.source)
        file.write_bytes(original)
        file.unlink()
        with self.assertRaisesRegex(ki.InstallError,'MISSING'):ki.verify_package(self.source)
        file.write_bytes(original)
        (self.source/'extra').write_text('unexpected')
        with self.assertRaisesRegex(ki.InstallError,'UNDECLARED'):ki.verify_package(self.source)

    def test_manifest_rejects_traversal_reserved_ads_and_case(self):
        path = self.source/'MANIFEST.json'
        original = json.loads(path.read_text())
        for name in ('../escape','/absolute','C:/abs','dir\\file','CON.txt','a.','x:y','bin/../foo'):
            changed = dict(original, files=[{'path':name,'sha256':'0'*64}])
            path.write_text(json.dumps(changed))
            with self.subTest(name=name),self.assertRaises(ki.InstallError):ki.verify_package(self.source)
        changed = dict(original,files=original['files']+[dict(original['files'][0],path=original['files'][0]['path'].upper())])
        path.write_text(json.dumps(changed))
        with self.assertRaisesRegex(ki.InstallError,'COLLISION'):ki.verify_package(self.source)

    def test_fresh_install_mcp_and_preserving_uninstall(self):
        result = ki.install(self.source,self.target)
        self.assertEqual(result['status'],'PASS')
        self.assertEqual(result['version'],'0.2.0-ai.1')
        state = Path(result['state'])
        self.assertNotIn(self.target/'current',state.parents)
        (state/'keep.txt').write_text('customer state')
        config = ki.generate_mcp(self.target)
        server = config['mcpServers']['manus-kit']
        self.assertTrue(Path(server['command']).is_absolute())
        self.assertTrue(Path(server['args'][1]).is_absolute())
        self.assertNotIn('env',server)
        self.assertEqual(ki.uninstall(self.target)['status'],'PASS')
        self.assertEqual((state/'keep.txt').read_text(),'customer state')
        self.assertFalse((self.target/'current').exists())

    def test_update_success_and_rollback_preserve_state(self):
        ki.install(self.source,self.target)
        (self.target/'state'/'keep').write_text('retained')
        second = fixture(self.base/'second','0.2.0-ai.2')
        output = self.base/'update.zip'
        digest = archive(second,output)
        result = ki.update(output,digest,self.target)
        self.assertEqual(result['version'],'0.2.0-ai.2')
        self.assertTrue((self.target/'backups'/result['backup_id']).is_dir())
        self.assertEqual(ki.rollback(self.target)['version'],'0.2.0-ai.1')
        self.assertEqual((self.target/'state'/'keep').read_text(),'retained')

    def test_failed_test_update_keeps_current(self):
        ki.install(self.source,self.target)
        second = fixture(self.base/'second','0.2.0-ai.2',broken=True)
        output = self.base/'update.zip'
        digest = archive(second,output)
        with self.assertRaisesRegex(ki.InstallError,'OFFLINE_TEST_FAILED'):ki.update(output,digest,self.target)
        self.assertEqual(ki.check_version(self.target)['installed'],'0.2.0-ai.1')

    def test_failed_postinstall_rolls_back_automatically(self):
        ki.install(self.source,self.target)
        second = fixture(self.base/'second','0.2.0-ai.2')
        output = self.base/'update.zip'
        digest = archive(second,output)
        actual = ki.self_test
        calls = []
        def fail_after_switch(path,executable):
            calls.append(path)
            if len(calls)==2:raise ki.InstallError('SIMULATED_POST_SWITCH_FAILURE')
            return actual(path,executable)
        with patch.object(ki,'self_test',side_effect=fail_after_switch):
            with self.assertRaisesRegex(ki.InstallError,'SIMULATED'):ki.update(output,digest,self.target)
        self.assertEqual(ki.check_version(self.target)['installed'],'0.2.0-ai.1')

    def test_external_checksum_and_mode_downgrade_gates(self):
        ki.install(self.source,self.target)
        second = fixture(self.base/'second','0.2.0-human.2')
        output = self.base/'update.zip'
        digest = archive(second,output)
        for value in ('','0'*64):
            with self.subTest(value=value),self.assertRaises(ki.InstallError):ki.update(output,value,self.target)
        with self.assertRaisesRegex(ki.InstallError,'SAME_MODE'):ki.update(output,digest,self.target)

    def test_unowned_destination_and_concurrent_install_rejected(self):
        self.target.mkdir()
        (self.target/'customer').write_text('preserve')
        with self.assertRaisesRegex(ki.InstallError,'NOT_OWNED'):ki.install(self.source,self.target)
        self.assertEqual((self.target/'customer').read_text(),'preserve')
        (self.target/'customer').unlink()
        ki.install(self.source,self.target)
        (self.target/'.install.lock').write_text('other process')
        with self.assertRaisesRegex(ki.InstallError,'LOCKED'):ki.rollback(self.target)

    def test_zip_traversal_link_collision_rejected(self):
        for index, names in enumerate((['../escape'],['kit/a','kit/A'])):
            output = self.base/f'bad{index}.zip'
            with zipfile.ZipFile(output,'w') as z:
                for name in names:z.writestr(name,'bad')
            digest = hashlib.sha256(output.read_bytes()).hexdigest()
            dest = self.base/f'extract{index}';dest.mkdir()
            with self.assertRaises(ki.InstallError):ki.extract_verified_zip(output,digest,dest)
            self.assertFalse((self.base/'escape').exists())
        output = self.base/'link.zip'
        with zipfile.ZipFile(output,'w') as z:
            info = zipfile.ZipInfo('link');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16
            z.writestr(info,'target')
        dest=self.base/'extract-link';dest.mkdir()
        with self.assertRaisesRegex(ki.InstallError,'LINK'):ki.extract_verified_zip(output,hashlib.sha256(output.read_bytes()).hexdigest(),dest)

    def test_zip_raw_name_normalization_denied_before_extraction(self):
        original_archive = self.base/'raw-original.zip'
        archive(self.source, original_archive)
        original = original_archive.read_bytes()
        good = b'kit/bin/manus-kit.py'
        self.assertEqual(original.count(good),2)  # local header and central directory
        malicious = (
            b'kit/bin\\manus-kit.py',  # Windows ZipInfo turns this into a slash
            b'kit/bin\x00manus-kit.py',  # ZipInfo truncates at NUL
            b'kit/bin\x01manus-kit.py',  # unnormalized control character
            b'kit/bin/manus-kit.p ',    # Windows trailing-space ambiguity
        )
        for index, bad in enumerate(malicious):
            with self.subTest(index=index):
                self.assertEqual(len(good),len(bad))
                modified = self.base/f'raw-malicious-{index}.zip'
                modified.write_bytes(original.replace(good,bad))
                dest = self.base/f'raw-extract-{index}'
                dest.mkdir()
                with self.assertRaisesRegex(ki.InstallError,'UNSAFE_PATH'):
                    ki.extract_verified_zip(modified,hashlib.sha256(modified.read_bytes()).hexdigest(),dest)
                self.assertEqual(list(dest.iterdir()),[])  # fail before any writes

    def test_recovery_restores_interrupted_switch(self):
        ki.install(self.source,self.target)
        token='1'*32
        (self.target/'current').rename(self.target/'backups'/token)
        (self.target/'current').mkdir()
        (self.target/'current'/'damaged').write_text('incomplete')
        ki._write(self.target/'install-transaction.json',{'token':token,'had_current':True,'committed':False})
        ki._recover(self.target)
        self.assertEqual(ki.verify_package(self.target/'current')['version'],'0.2.0-ai.1')
        self.assertFalse((self.target/'install-transaction.json').exists())

    def test_symlinks_rejected_when_supported(self):
        linked = self.source/'link'
        try:linked.symlink_to(self.base,target_is_directory=True)
        except (OSError,NotImplementedError):self.skipTest('OS does not allow symlink creation')
        with self.assertRaisesRegex(ki.InstallError,'LINK'):ki.verify_package(self.source)


if __name__=='__main__':unittest.main()
