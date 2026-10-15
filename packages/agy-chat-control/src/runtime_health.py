"""A cached boolean is never sufficient proof of a live executor."""
import ctypes,os,time
def pid_alive(pid):
 if type(pid)is not int or pid<=0:return False
 if os.name=='nt':
  kernel=ctypes.WinDLL('kernel32',use_last_error=True)
  kernel.OpenProcess.argtypes=[ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong];kernel.OpenProcess.restype=ctypes.c_void_p
  handle=kernel.OpenProcess(0x1000,False,pid)
  if not handle:return None if ctypes.get_last_error()==5 else False
  try:
   code=ctypes.c_ulong();kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]
   return bool(kernel.GetExitCodeProcess(handle,ctypes.byref(code)))and code.value==259
  finally:kernel.CloseHandle.argtypes=[ctypes.c_void_p];kernel.CloseHandle(handle)
 try:os.kill(pid,0);return True
 except PermissionError:return None
 except ProcessLookupError:return False
def assess(status,now=None,probe=pid_alive):
 now=time.time()if now is None else now;stamp=status.get('emitted_at');pid=(status.get('binding')or{}).get('pid')
 live=probe(pid)
 if live is False:return {'status':'STOPPED','daemon_alive_verified':False,'reason':'PROCESS_ABSENT','cached_daemon_alive':status.get('daemon_alive')}
 if type(stamp)not in{int,float}or not 0<=now-stamp<=15:return {'status':'STALE','daemon_alive_verified':False,'reason':'MISSING_OR_STALE_EMITTED_AT','cached_daemon_alive':status.get('daemon_alive')}
 if live is not True:return {'status':'UNVERIFIED','daemon_alive_verified':False,'reason':'PROCESS_QUERY_UNVERIFIED'}
 return {'status':'RUNNING'if status.get('daemon_alive')is True else'STOPPED','daemon_alive_verified':status.get('daemon_alive')is True,'emitted_at':stamp,'pid':pid}
