"""Keep this one-shot authoring process and its descendants in an owned job."""
import ctypes
import os
from ctypes import wintypes

# Retain the non-inheritable job handle until process exit. Closing it explicitly
# would terminate this process too, before its final receipt can be delivered.
_job_handle = None


def install_process_guard():
    global _job_handle
    if os.name != 'nt':
        return {'platform': os.name, 'jobAssigned': False, 'notRequired': True}

    class BasicLimits(ctypes.Structure):
        _fields_ = [('processTime', ctypes.c_longlong), ('jobTime', ctypes.c_longlong),
                    ('flags', wintypes.DWORD), ('minWorkingSet', ctypes.c_size_t),
                    ('maxWorkingSet', ctypes.c_size_t), ('activeProcesses', wintypes.DWORD),
                    ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD),
                    ('scheduling', wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ('readOps', 'writeOps', 'otherOps', 'readBytes', 'writeBytes', 'otherBytes')]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('basic', BasicLimits), ('io', IoCounters),
                    ('processMemory', ctypes.c_size_t), ('jobMemory', ctypes.c_size_t),
                    ('peakProcessMemory', ctypes.c_size_t), ('peakJobMemory', ctypes.c_size_t)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        code = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(code)
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        code = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(code)
    _job_handle = handle
    return {'platform': 'win32', 'jobAssigned': True, 'killOnClose': True, 'processId': os.getpid()}
