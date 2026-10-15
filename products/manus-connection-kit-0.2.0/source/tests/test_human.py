"""Offline boundaries; no owner credentials, live API calls, or visible GUI."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from human_ui import (APP, MARKER, install_exe, rollback_exe, uninstall_exe, sha,
                      test_connection, mcp_config, local_self_test, safe_root, HumanUI)
from windows_secret import SecretStore, SecretError
from manus_kit import Api, KitError

class HumanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mck-human-test-')
        self.base = Path(self.temp.name); self.root=self.base/'install'; self.state=self.base/'state'
        self.a=self.base/'a.exe';self.a.write_bytes(b'first-fixture')
        self.b=self.base/'b.exe';self.b.write_bytes(b'second-fixture')
    def tearDown(self): self.temp.cleanup()
    def test_install_update_rollback_uninstall_preserves_state(self):
        self.state.mkdir(); (self.state/'journal.sqlite').write_bytes(b'preserve')
        self.assertEqual('PASS',install_exe(self.a,self.root)['status'])
        self.assertFalse((self.root/'install.lock').exists())
        self.assertEqual('ALREADY_INSTALLED',install_exe(self.a,self.root)['action'])
        self.assertEqual('PASS',install_exe(self.b,self.root,verify=sha(self.b))['status'])
        self.assertEqual('PASS',rollback_exe(self.root)['status'])
        self.assertEqual(sha(self.a),sha(self.root/'current'/APP))
        self.assertEqual('PASS',uninstall_exe(self.root)['status'])
        self.assertEqual(b'preserve',(self.state/'journal.sqlite').read_bytes())
    def test_checksum_and_update_requirements(self):
        with self.assertRaisesRegex(ValueError,'CHECKSUM'): install_exe(self.a,self.root,verify='0'*64)
        install_exe(self.a,self.root)
        with self.assertRaisesRegex(ValueError,'TRUSTED_UPDATE'): install_exe(self.b,self.root)
        self.assertEqual(sha(self.a),sha(self.root/'current'/APP))
    def test_unowned_and_tampered_backup_denied(self):
        self.root.mkdir(); (self.root/'unrelated').write_text('owner')
        with self.assertRaisesRegex(ValueError,'NOT_OWNED'): install_exe(self.a,self.root)
        (self.root/'unrelated').unlink();self.root.rmdir()
        install_exe(self.a,self.root);install_exe(self.b,self.root,verify=sha(self.b))
        marker=json.loads((self.root/MARKER).read_text())
        (self.root/marker['previous']).write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError,'BACKUP_CHECKSUM'): rollback_exe(self.root)
        self.assertEqual(sha(self.b),sha(self.root/'current'/APP))
    def test_candidate_failure_preserves_active(self):
        install_exe(self.a,self.root)
        with patch('human_ui.probe_exe', side_effect=ValueError('CANDIDATE_SELF_TEST_FAILED')):
            with self.assertRaises(ValueError): install_exe(self.b,self.root,verify=sha(self.b))
        self.assertEqual(sha(self.a),sha(self.root/'current'/APP))
    def test_activation_failure_rolls_back(self):
        install_exe(self.a,self.root)
        with patch('human_ui.probe_exe', side_effect=[None,ValueError('POST_INSTALL_FAILED')]):
            with self.assertRaises(ValueError): install_exe(self.b,self.root,verify=sha(self.b))
        self.assertEqual(sha(self.a),sha(self.root/'current'/APP))
    def test_install_lock_refuses_second_installer(self):
        install_exe(self.a,self.root);(self.root/'install.lock').write_text('held')
        with self.assertRaises(FileExistsError): install_exe(self.b,self.root,verify=sha(self.b))
        (self.root/'install.lock').unlink()
    def test_reparse_root_rejected(self):
        # Windows junction creation requires no administrator or symlink privilege.
        target=self.base/'outside';target.mkdir();link=self.base/'alias'
        import subprocess
        result=subprocess.run(['cmd','/c','mklink','/J',str(link),str(target)],capture_output=True)
        if result.returncode: self.skipTest('Junction creation unavailable')
        try:
            with self.assertRaisesRegex(ValueError,'LINK_DENIED'): safe_root(link)
            install_exe(self.a,self.root)
            current=self.root/'current';(current/APP).unlink();current.rmdir()
            subprocess.run(['cmd','/c','mklink','/J',str(current),str(target)],capture_output=True,check=True)
            try:
                with self.assertRaisesRegex(ValueError,'LINK_DENIED'):install_exe(self.b,self.root,verify=sha(self.b))
            finally:current.rmdir()
        finally:link.rmdir()
    @unittest.skipUnless(os.name=='nt','Windows DPAPI only')
    def test_dpapi_ciphertext_update_remove_corruption(self):
        store=SecretStore(self.state);store.save('offline-fixture-only')
        self.assertNotIn(b'offline-fixture-only',store.path.read_bytes())
        self.assertEqual('offline-fixture-only',store.load())
        store.save('changed-fixture');self.assertEqual('changed-fixture',store.load())
        store.path.write_bytes(b'invalid')
        with self.assertRaises(SecretError):store.load()
        store.remove();self.assertFalse(store.path.exists())
    def test_auth_missing_key_and_injected_transport(self):
        self.assertEqual('API_KEY_REQUIRED',test_connection(self.state)['reason'])
        SecretStore(self.state).save('offline-fixture-only')
        calls=[]
        def transport(endpoint, params, body):
            calls.append(endpoint);return {'ok':True,'user_id':'synthetic-user','request_id':'fixture-request'}
        result=test_connection(self.state,api_factory=lambda key:Api(key,transport=transport))
        self.assertEqual('PASS',result['status']);self.assertEqual(['user.me'],calls)
        def denied(key):raise KitError('PROVIDER_HTTP_401')
        self.assertEqual('PROVIDER_HTTP_401',test_connection(self.state,api_factory=denied)['reason'])
        def leak(key):raise ValueError('offline-fixture-only')
        self.assertNotIn('offline-fixture-only',json.dumps(test_connection(self.state,api_factory=leak)))
    def test_config_no_key_and_offline_selftest(self):
        self.assertNotIn('env',mcp_config(self.root,self.state)['mcpServers']['manus'])
        self.assertEqual(0,local_self_test()['network_requests'])
    def test_withdrawn_gui_key_entry_actions(self):
        import tkinter as tk
        window=tk.Tk();window.withdraw()
        try:
            ui=HumanUI(window,self.root,self.state)
            ui.key.set('offline-ui-fixture');ui.save_key()
            self.assertEqual('',ui.key.get());self.assertIn('PASS',ui.status.get())
            self.assertEqual('offline-ui-fixture',SecretStore(self.state).load())
            ui.remove_key();self.assertIn('KEY_REMOVED',ui.status.get())
            entries=[widget for frame in window.winfo_children() for widget in frame.winfo_children() if widget.winfo_class()=='TEntry']
            self.assertEqual('•',entries[0].cget('show'))
            # This validates instantiated widgets and handlers, not visual rendering/usability.
        finally:window.destroy()

if __name__=='__main__':unittest.main()
