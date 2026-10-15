"""Offline Windows onboarding and encrypted-key local MCP launcher."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from windows_secret import SecretStore, SecretError
from manus_kit import Adapter, Api, Journal, KitError

VERSION = '0.2.0-human.1'
APP = 'ManusConnectionKit.exe'
MARKER = 'mck-human-install.json'

def default_paths():
    local = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData' / 'Local')))
    return local / 'ManusConnectionKit' / 'human', local / 'ManusConnectionKitState'

def sha(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()

def no_links(path):
    path = Path(os.path.abspath(path))
    for item in (path, *path.parents):
        try:
            stat = item.lstat()
        except FileNotFoundError:
            continue
        if item.is_symlink() or getattr(stat, 'st_file_attributes', 0) & 0x400:
            raise ValueError('INSTALL_LINK_DENIED')
    return path

def safe_root(root):
    root = no_links(root).resolve()
    if root == root.parent or len(root.parts) < 3:
        raise ValueError('INSTALL_ROOT_REJECTED')
    return root

def probe_exe(path):
    if getattr(sys, 'frozen', False):
        probe = subprocess.run([str(path), '--self-test'], capture_output=True, timeout=45)
        if probe.returncode: raise ValueError('CANDIDATE_SELF_TEST_FAILED')

@contextmanager
def operation_lock(root):
    lock=no_links(Path(root)/'install.lock')
    with lock.open('x'): pass
    try: yield
    finally:lock.unlink(missing_ok=True)

def error_result(error):
    allowed={'INSTALL_ROOT_REJECTED','INSTALL_LINK_DENIED','INSTALL_CHECKSUM_MISMATCH',
        'INSTALL_ROOT_NOT_OWNED','COPY_VERIFY_FAILED','CANDIDATE_SELF_TEST_FAILED',
        'TRUSTED_UPDATE_CHECKSUM_REQUIRED','BACKUP_PATH_REJECTED','BACKUP_CHECKSUM_MISMATCH',
        'PRIVATE_STATE_OVERLAPS_INSTALL','FROZEN_INSTALLER_REQUIRED','WINDOWS_PARENT_STILL_RUNNING'}
    code=str(error) if isinstance(error,ValueError) and str(error) in allowed else 'LOCAL_OPERATION_REJECTED'
    if isinstance(error,FileExistsError):code='ANOTHER_OPERATION_OR_RECOVERY_LOCK'
    return {'status':'BLOCKED','reason':code}

def write_marker(root, value):
    marker = no_links(root / MARKER)
    temp = no_links(root / (MARKER + '.new'))
    temp.write_text(json.dumps(value), encoding='utf-8')
    os.replace(temp, marker)

def install_exe(source, root, *, verify=None):
    root = safe_root(root)
    source = Path(source).resolve()
    digest = sha(source)
    if verify and digest.lower() != verify.lower():
        raise ValueError('INSTALL_CHECKSUM_MISMATCH')
    no_links(root / MARKER)
    if root.exists() and not (root / MARKER).is_file() and any(root.iterdir()):
        raise ValueError('INSTALL_ROOT_NOT_OWNED')
    root.mkdir(parents=True, exist_ok=True)
    if (root / MARKER).is_file(): owned(root)
    lock = no_links(root / 'install.lock')
    with lock.open('x'):
        pass
    try:
            current = no_links(root / 'current')
            current.mkdir(exist_ok=True)
            target = no_links(current / APP)
            if target.exists() and sha(target) == digest:
                return {'status':'PASS','action':'ALREADY_INSTALLED','sha256':digest}
            old_marker = json.loads((root / MARKER).read_text(encoding='utf-8')) if (root / MARKER).exists() else None
            if target.exists() and not verify:
                raise ValueError('TRUSTED_UPDATE_CHECKSUM_REQUIRED')
            stage = no_links(current / (APP + '.new'))
            shutil.copyfile(source, stage)
            if sha(stage) != digest:
                raise ValueError('COPY_VERIFY_FAILED')
            # Execute the candidate's offline tests BEFORE replacing current.
            try: probe_exe(stage)
            except Exception:
                stage.unlink(missing_ok=True)
                raise
            previous = None
            if target.exists():
                backup = no_links(root / 'backups' / str(time.time_ns()))
                backup.mkdir(parents=True)
                previous = no_links(backup / APP)
                shutil.copyfile(target, previous)
            try:
                os.replace(stage, target)
                probe_exe(target)
                write_marker(root, {'product':'ManusConnectionKit','version':VERSION,
                    'sha256':digest,'previous':str(previous.relative_to(root)) if previous else None,
                    'previous_sha256':sha(previous) if previous else None})
            except Exception:
                if previous and previous.exists():
                    shutil.copyfile(previous, target)
                    if old_marker: write_marker(root, old_marker)
                else: target.unlink(missing_ok=True)
                raise
            return {'status':'PASS','action':'INSTALLED','sha256':digest,'path':str(target)}
    finally:
        lock.unlink(missing_ok=True)

def owned(root):
    root = safe_root(root)
    no_links(root / MARKER)
    marker = json.loads((root / MARKER).read_text(encoding='utf-8'))
    if marker.get('product') != 'ManusConnectionKit': raise ValueError('INSTALL_ROOT_NOT_OWNED')
    return root, marker

def rollback_exe(root):
    root,_=owned(root)
    with operation_lock(root):return _rollback_exe(root)

def _rollback_exe(root):
    root, marker = owned(root)
    previous = marker.get('previous')
    if not previous: return {'status':'BLOCKED','reason':'NO_PREVIOUS_VERSION'}
    backup = no_links(root / previous).resolve()
    if not backup.is_relative_to(root / 'backups') or backup.name != APP:
        raise ValueError('BACKUP_PATH_REJECTED')
    if sha(backup) != marker.get('previous_sha256'): raise ValueError('BACKUP_CHECKSUM_MISMATCH')
    probe_exe(backup)
    target = no_links(root / 'current' / APP)
    stage = no_links(target.with_suffix('.rollback'))
    shutil.copyfile(backup, stage)
    displaced = no_links(target.with_suffix('.displaced'))
    shutil.copyfile(target, displaced)
    try:
        os.replace(stage, target)
        probe_exe(target)
    except Exception:
        os.replace(displaced,target)
        raise
    finally:
        displaced.unlink(missing_ok=True)
    marker.update(sha256=sha(target), previous=None, previous_sha256=None, version='ROLLED_BACK')
    write_marker(root, marker)
    return {'status':'PASS','action':'ROLLED_BACK'}

def uninstall_exe(root):
    root,_=owned(root)
    with operation_lock(root):result=_uninstall_exe(root)
    try: root.rmdir()
    except OSError:pass
    return result

def _uninstall_exe(root):
    root, _ = owned(root)
    # Only owned binary paths are removed; journal and encrypted key live elsewhere.
    no_links(root / 'current' / APP).unlink(missing_ok=True)
    no_links(root / 'backups')
    for backup in (root / 'backups').glob('*/' + APP) if (root / 'backups').exists() else []:
        no_links(backup)
        backup.unlink()
        try: backup.parent.rmdir()
        except OSError: pass
    (root / MARKER).unlink()
    for folder in ('current', 'backups'):
        try: (root / folder).rmdir()
        except OSError: pass
    try: root.rmdir()
    except OSError: pass
    return {'status':'PASS','action':'UNINSTALLED','private_state':'PRESERVED_FOR_RECONCILIATION'}

def test_connection(state, *, api_factory=Api):
    journal = None
    try:
        no_links(Path(state) / 'journal')
        key = SecretStore(state).load()
        journal = Journal(Path(state) / 'journal')
        # user.me only. No task creation, quota purchase, blind retries or prompt.
        result = Adapter(journal, api_factory(key)).auth()
        return {'status':'PASS','level':'AUTH_VERIFIED','request_id':result.get('request_id')}
    except (KitError, SecretError) as error:
        return {'status':'BLOCKED','reason':error.code if isinstance(error, KitError) else str(error)}
    except Exception:
        return {'status':'BLOCKED','reason':'LOCAL_CONNECTION_ERROR'}
    finally:
        if journal: journal.close()

def mcp_config(root, state, grant=None):
    args = ['--mcp', '--state', str(Path(state).resolve())]
    if grant: args += ['--grant', str(Path(grant).resolve())]
    return {'mcpServers':{'manus':{'command':str(Path(root).resolve() / 'current' / APP),'args':args}}}

def local_self_test():
    # No credentials, no live networking, and no private journal.
    if getattr(sys,'frozen',False):
        extraction=Path(sys._MEIPASS)
        manifest=json.loads((extraction/'internal'/'MANIFEST.json').read_text(encoding='utf-8'))
        for entry in manifest['files']:
            file=(extraction/entry['path']).resolve()
            if not file.is_relative_to(extraction) or sha(file)!=entry['sha256']:
                raise ValueError('EMBEDDED_MANIFEST_MISMATCH')
    with tempfile.TemporaryDirectory(prefix='mck-selftest-') as temp:
        root = Path(temp)
        store = SecretStore(root)
        store.save('offline-selftest-key')
        if store.load() != 'offline-selftest-key': raise ValueError('DPAPI_TEST_FAILED')
        if b'offline-selftest-key' in store.path.read_bytes(): raise ValueError('KEY_PLAINTEXT')
        store.remove()
        journal = Journal(root / 'journal')
        try:
            result = Adapter(journal, Api('offline-selftest-key', transport=lambda *args: {'ok':True,'user_id':'fixture'})).auth()
            if not result.get('AUTH_VERIFIED'): raise ValueError('CORE_TEST_FAILED')
        finally: journal.close()
    return {'status':'PASS','level':'LOCAL_FUNCTION_PASS','network_requests':0,'version':VERSION}

class HumanUI:
    def __init__(self, window, root, state):
        import tkinter as tk
        from tkinter import ttk
        self.window, self.root, self.state = window, Path(root), Path(state)
        self.status = tk.StringVar(value='1. Install. 2. Save your API key. 3. Test Connection.')
        self.key = tk.StringVar()
        window.title('Manus Connection Kit — Easy Human Mode')
        window.geometry('720x600')
        frame = ttk.Frame(window, padding=24); frame.pack(fill='both', expand=True)
        ttk.Label(frame, text='Manus Connection Kit', font=('Segoe UI', 20, 'bold')).pack(anchor='w')
        ttk.Label(frame, text='Easy Human Mode · ' + VERSION).pack(anchor='w', pady=(0,16))
        ttk.Label(frame, text='Install for your Windows account. No Python or terminal needed.').pack(anchor='w')
        ttk.Button(frame, text='1. Install / Update', command=self.install).pack(anchor='w', pady=10)
        ttk.Label(frame, text='Your Manus API key (stored encrypted for this Windows account)').pack(anchor='w')
        ttk.Entry(frame, textvariable=self.key, show='•', width=65).pack(anchor='w', pady=6)
        ttk.Button(frame, text='2. Save Key', command=self.save_key).pack(anchor='w')
        ttk.Button(frame, text='3. Test Connection', command=self.test).pack(anchor='w', pady=10)
        ttk.Button(frame, text='Create AI Client Connection File', command=self.export_config).pack(anchor='w')
        ttk.Button(frame, text='Open Installed App Folder', command=self.open_app_folder).pack(anchor='w', pady=4)
        ttk.Label(frame, text='Compatible local AI clients must support MCP stdio.\nOrdinary web chats cannot directly use this local connection.\nCreating tasks still requires a fresh owner-authorized grant.', wraplength=650).pack(anchor='w', pady=12)
        row = ttk.Frame(frame); row.pack(anchor='w')
        ttk.Button(row, text='Rollback', command=lambda:self.maintenance('rollback')).pack(side='left')
        ttk.Button(row, text='Uninstall', command=lambda:self.maintenance('uninstall')).pack(side='left', padx=8)
        ttk.Button(row, text='Remove Saved Key', command=self.remove_key).pack(side='left')
        ttk.Label(frame, textvariable=self.status, wraplength=650, foreground='#17446d').pack(anchor='w', pady=16)
        ttk.Label(frame, text='Private pilot · unsigned installer · commercial license/support unresolved', wraplength=650).pack(anchor='w')
    def show(self, result):
        self.status.set(result.get('status','BLOCKED') + ' — ' + result.get('reason',result.get('action',result.get('level','Done'))))
    def install(self):
        if not getattr(sys,'frozen',False):
            self.show({'status':'BLOCKED','reason':'WHY_INSTALLER_COULD_NOT_DO_IT: USE_PACKAGED_EXE'}); return
        from tkinter import simpledialog
        expected = None
        installed = self.root / 'current' / APP
        if installed.is_file() and sha(installed) != sha(sys.executable):
            expected = simpledialog.askstring('Verify update', 'Version: '+VERSION+'\nPaste the 64-character SHA-256 from a separately trusted release receipt.\nAn unsigned download alone cannot establish publisher identity.')
            if not expected or len(expected.strip()) != 64:
                self.show({'status':'BLOCKED','reason':'TRUSTED_UPDATE_CHECKSUM_REQUIRED'}); return
            expected = expected.strip()
        self.background(lambda:install_exe(sys.executable,self.root,verify=expected))
    def save_key(self):
        try:
            SecretStore(self.state).save(self.key.get()); self.key.set('')
            self.show({'status':'PASS','action':'KEY_SAVED_ENCRYPTED'})
        except Exception: self.show({'status':'BLOCKED','reason':'KEY_SAVE_FAILED'})
    def remove_key(self):
        try: SecretStore(self.state).remove(); self.key.set(''); self.show({'status':'PASS','action':'KEY_REMOVED'})
        except Exception: self.show({'status':'BLOCKED','reason':'KEY_REMOVE_FAILED'})
    def background(self, fn):
        self.status.set('Working…')
        def run():
            try: result=fn()
            except Exception as error: result=error_result(error)
            self.window.after(0, lambda:self.show(result))
        threading.Thread(target=run,daemon=True).start()
    def test(self): self.background(lambda:test_connection(self.state))
    def export_config(self):
        from tkinter import filedialog
        if not (self.root / 'current' / APP).is_file():
            self.show({'status':'BLOCKED','reason':'INSTALL_FIRST'}); return
        destination = filedialog.asksaveasfilename(title='Save AI client connection file',initialfile='manus-mcp.json',defaultextension='.json')
        if not destination: return
        try:
            Path(destination).write_text(json.dumps(mcp_config(self.root,self.state),indent=2),encoding='utf-8')
            self.show({'status':'PASS','action':'CLIENT_CONFIG_SAVED — IMPORT_IN_COMPATIBLE_LOCAL_AI'})
        except Exception: self.show({'status':'BLOCKED','reason':'CONFIG_SAVE_FAILED'})
    def open_app_folder(self):
        try:
            folder=no_links(self.root/'current')
            if not folder.is_dir(): raise ValueError('INSTALL_FIRST')
            os.startfile(str(folder))
        except Exception:self.show({'status':'BLOCKED','reason':'INSTALL_FIRST'})
    def maintenance(self, operation):
        from tkinter import messagebox
        if not messagebox.askyesno(operation.title(), 'Continue? Your private journal and saved key will be preserved. Close connected AI clients first.'): return
        try:
            installed = self.root / 'current' / APP
            if getattr(sys,'frozen',False) and Path(sys.executable).resolve()==installed.resolve():
                # Work from a temporary executable after this process exits to avoid Windows file locks.
                temp = Path(tempfile.mkdtemp(prefix='mck-maintenance-')) / APP
                shutil.copyfile(sys.executable,temp)
                subprocess.Popen([str(temp),'--maintenance-worker',operation,'--install-root',str(self.root),
                                  '--parent-pid',str(os.getpid()),'--bootloader-pid',str(os.getppid()),
                                  '--notify-maintenance'],close_fds=True)
                self.window.destroy()
            else:
                self.show(rollback_exe(self.root) if operation=='rollback' else uninstall_exe(self.root))
        except Exception: self.show({'status':'BLOCKED','reason':'MAINTENANCE_FAILED_CLOSE_AI_CLIENTS'})

def main(argv=None):
    parser=argparse.ArgumentParser(description='Manus Connection Kit Easy Human Mode')
    parser.add_argument('--self-test',action='store_true')
    parser.add_argument('--mcp',action='store_true')
    parser.add_argument('--state',type=Path)
    parser.add_argument('--grant',type=Path)
    parser.add_argument('--install-root',type=Path)
    parser.add_argument('--install-headless',action='store_true')
    parser.add_argument('--expected-sha256')
    parser.add_argument('--maintenance-worker',choices=['rollback','uninstall'])
    parser.add_argument('--parent-pid',type=int)
    parser.add_argument('--bootloader-pid',type=int)
    parser.add_argument('--notify-maintenance',action='store_true')
    parser.add_argument('--result-file',type=Path)
    args=parser.parse_args(argv)
    root,state=default_paths();root=args.install_root or root;state=args.state or state
    result=None
    try:
        root = safe_root(root); state = safe_root(state)
        no_links(state / 'journal')
        if root == state or root.is_relative_to(state) or state.is_relative_to(root):
            raise ValueError('PRIVATE_STATE_OVERLAPS_INSTALL')
        if args.self_test: result=local_self_test()
        elif args.install_headless:
            if not getattr(sys,'frozen',False): raise ValueError('FROZEN_INSTALLER_REQUIRED')
            result=install_exe(sys.executable,root,verify=args.expected_sha256)
        elif args.maintenance_worker:
            if args.parent_pid:
                import ctypes
                from ctypes import wintypes
                kernel=ctypes.WinDLL('kernel32',use_last_error=True)
                kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
                kernel.OpenProcess.restype=wintypes.HANDLE
                kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
                kernel.WaitForSingleObject.restype=wintypes.DWORD
                kernel.CloseHandle.argtypes=[wintypes.HANDLE]
                for pid in (args.parent_pid,args.bootloader_pid):
                    if not pid:continue
                    handle=kernel.OpenProcess(0x100000,False,pid)
                    if handle:
                        waited=kernel.WaitForSingleObject(handle,15000)
                        kernel.CloseHandle(handle)
                        if waited != 0: raise ValueError('WINDOWS_PARENT_STILL_RUNNING')
            result=rollback_exe(root) if args.maintenance_worker=='rollback' else uninstall_exe(root)
        elif args.mcp:
            from mcp_server import serve
            # PyInstaller windowed mode leaves stdio None; reconnect to inherited standard handles.
            if sys.stdin is None or sys.stdout is None:
                import ctypes, msvcrt, io
                for attr,number,mode in [('stdin',-10,'r'),('stdout',-11,'w')]:
                    get=ctypes.windll.kernel32.GetStdHandle;get.restype=ctypes.c_void_p
                    handle=get(number)
                    fd=msvcrt.open_osfhandle(handle,os.O_RDONLY if mode=='r' else os.O_WRONLY)
                    setattr(sys,attr,io.TextIOWrapper(os.fdopen(fd,mode+'b',buffering=0),encoding='utf-8',write_through=True))
            key=SecretStore(state).load(); journal=Journal(Path(state)/'journal')
            try: serve(journal,key,args.grant)
            finally: journal.close()
            return 0
        else:
            import tkinter as tk
            window=tk.Tk();HumanUI(window,root,state);window.mainloop();return 0
    except Exception as error:
        result=error_result(error)
    if args.result_file:
        args.result_file.write_text(json.dumps(result,indent=2),encoding='utf-8')
    if args.notify_maintenance and args.maintenance_worker:
        import tkinter as tk
        from tkinter import messagebox
        window=tk.Tk();window.withdraw()
        messagebox.showinfo('Manus Connection Kit',result.get('status','BLOCKED')+' — '+result.get('reason',result.get('action','Complete'))+'\nPrivate journal and saved key are preserved.')
        window.destroy()
    if sys.stdout: print(json.dumps(result))
    return 0 if result and result.get('status')=='PASS' else 2

