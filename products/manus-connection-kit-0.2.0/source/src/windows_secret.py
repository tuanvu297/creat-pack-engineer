"""Windows CurrentUser DPAPI secret storage. Never use registry or environment."""
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import secrets

class SecretError(Exception):
    pass

class DATA_BLOB(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]

def _crypt(raw, decrypt=False):
    if os.name != 'nt':
        raise SecretError('WINDOWS_DPAPI_REQUIRED')
    source = ctypes.create_string_buffer(raw)
    input_blob = DATA_BLOB(len(raw), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    output = DATA_BLOB()
    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    fn = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    fn.argtypes = [ctypes.POINTER(DATA_BLOB), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                   ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DATA_BLOB)]
    fn.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    # CRYPTPROTECT_UI_FORBIDDEN; no LOCAL_MACHINE flag: this Windows user only.
    if not fn(ctypes.byref(input_blob), None, None, None, None, 1, ctypes.byref(output)):
        raise SecretError('KEY_DECRYPT_FAILED' if decrypt else 'KEY_ENCRYPT_FAILED')
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)
        ctypes.memset(source, 0, len(raw))

class SecretStore:
    def __init__(self, state):
        self.path = Path(state) / 'api-key.dpapi'
    def save(self, key):
        if not isinstance(key, str) or not key.strip() or len(key) > 8192:
            raise SecretError('KEY_INPUT_INVALID')
        encrypted = _crypt(key.strip().encode('utf-8'))
        self._no_links()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.' + secrets.token_hex(8) + '.new')
        try:
            with temp.open('xb') as file:
                file.write(encrypted)
            os.replace(temp, self.path)
        finally: temp.unlink(missing_ok=True)
    def _no_links(self):
        for item in (self.path, *self.path.parents):
            try: stat = item.lstat()
            except FileNotFoundError: continue
            if item.is_symlink() or getattr(stat,'st_file_attributes',0) & 0x400:
                raise SecretError('STATE_LINK_DENIED')
    def load(self):
        self._no_links()
        if not self.path.is_file():
            raise SecretError('API_KEY_REQUIRED')
        if self.path.is_symlink() or self.path.stat().st_size > 65536:
            raise SecretError('KEY_FILE_REJECTED')
        try:
            return _crypt(self.path.read_bytes(), decrypt=True).decode('utf-8')
        except (OSError, UnicodeError):
            raise SecretError('KEY_DECRYPT_FAILED') from None
    def remove(self):
        self._no_links()
        self.path.unlink(missing_ok=True)
