using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// The job contains only the instance identified by Hancom's HWND. Disk receipts
// are diagnostics, never authority to attach/terminate an arbitrary old PID.
public sealed class JarvisHancomProcessGuard : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    readonly object gate = new object(); readonly ManualResetEvent stop = new ManualResetEvent(false);
    IntPtr job; Process parent; Thread watcher; bool disposed;
    public bool JobAssigned { get; private set; }
    public bool ParentWatchEnabled { get; private set; }
    public long ParentStartTicks { get; private set; }
    public long OwnedStartTicks { get; private set; }
    public JarvisHancomProcessGuard(int ownedPid, int parentPid) {
        try {
            using (Process owned = Process.GetProcessById(ownedPid)) {
                if (!String.Equals(owned.ProcessName, "Hwp", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("HANCOM_RENDER_GUARD_PROCESS_INVALID");
                OwnedStartTicks = owned.StartTime.ToUniversalTime().Ticks;
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!AssignProcessToJobObject(job, owned.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
                JobAssigned = true;
            }
            if (parentPid > 0) {
                parent = Process.GetProcessById(parentPid); ParentStartTicks = parent.StartTime.ToUniversalTime().Ticks;
                // Force acquisition now; later PID reuse cannot replace this handle.
                IntPtr handle = parent.Handle;
                watcher = new Thread(WatchParent); watcher.IsBackground = true; ParentWatchEnabled = true; watcher.Start();
            }
        } catch { Dispose(); throw; }
    }
    void WatchParent() {
        try {
            while (!stop.WaitOne(0)) {
                if (!parent.WaitForExit(250)) continue;
                lock (gate) { if (disposed) return; CloseJob(); }
                // The native host is this process, never a PID supplied by a caller.
                Process.GetCurrentProcess().Kill(); return;
            }
        } catch (ObjectDisposedException) { }
    }
    void CloseJob() { if (job != IntPtr.Zero) { IntPtr old = job; job = IntPtr.Zero; if (!CloseHandle(old)) throw new Win32Exception(Marshal.GetLastWin32Error()); } }
    public void Dispose() {
        lock (gate) { if (disposed) return; disposed = true; stop.Set(); CloseJob(); }
        if (watcher != null && watcher != Thread.CurrentThread) watcher.Join(1000);
        if (parent != null) parent.Dispose(); stop.Dispose();
    }
}

