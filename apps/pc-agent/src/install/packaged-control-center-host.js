import {renderVerifiedNodeRuntimeSource} from './bundled-node-runtime.js';
/** Native lifetime owner. Existing hosts are never terminated by this owner. */
export function renderPackagedControlCenterHostSource(){return renderVerifiedNodeRuntimeSource()+String.raw`
public sealed class PackagedControlCenterHost : System.IDisposable {
  private readonly string root, node, bundledHash;
  private readonly int port;
  private readonly object gate = new object();
  private System.Diagnostics.Process owned;
  private System.IntPtr job;
  private bool disposed;
  public int OwnedProcessId { get { lock(gate) { return owned == null || owned.HasExited ? 0 : owned.Id; } } }
  public PackagedControlCenterHost(string packageRoot, string nodeExecutable, int listenPort, string bundledNodeSha256 = null) {
    root = System.IO.Path.GetFullPath(packageRoot); node = nodeExecutable; port = listenPort; bundledHash = bundledNodeSha256;
    if(port < 1 || port > 65535) throw new System.ArgumentException("PC_UI_HOST_PORT_INVALID");
  }
  // 0 = connection refused, 1 = expected health, 2 = occupied/unverified.
  private int Probe() {
    try {
      var request=(System.Net.HttpWebRequest)System.Net.WebRequest.Create("http://127.0.0.1:"+port+"/health");
      request.Proxy=null; request.AllowAutoRedirect=false; request.Timeout=2500; request.ReadWriteTimeout=2500;
      using(var response=(System.Net.HttpWebResponse)request.GetResponse()) {
        if(response.StatusCode!=System.Net.HttpStatusCode.OK)return 2;
        using(var reader=new System.IO.StreamReader(response.GetResponseStream())) {
          var buffer=new char[4097]; int count=0,read;
          while(count<buffer.Length && (read=reader.Read(buffer,count,buffer.Length-count))>0)count+=read;
          if(count>4096)return 2;
          var body=new string(buffer,0,count);
          var parser=new System.Web.Script.Serialization.JavaScriptSerializer(); parser.MaxJsonLength=4096;
          var values=parser.Deserialize<System.Collections.Generic.Dictionary<string,object>>(body);
          object module,status;
          return values!=null && values.TryGetValue("module",out module) && values.TryGetValue("status",out status)
            && System.Object.Equals(module,"JARVIS_CONTROL_CENTER") && System.Object.Equals(status,"ok") ? 1 : 2;
        }
      }
    } catch(System.Net.WebException error) { return error.Status==System.Net.WebExceptionStatus.ConnectFailure ? 0 : 2; }
    catch { return 2; }
  }
  public void EnsureReady() {
    lock(gate) {
      using(var mutex=new System.Threading.Mutex(false,@"Local\JARVIS.ControlCenter.Host."+port)) {
      bool acquired=false;
      try {
      try { acquired=mutex.WaitOne(10000); } catch(System.Threading.AbandonedMutexException) { acquired=true; }
      if(!acquired)throw new System.InvalidOperationException("PC_UI_HOST_START_TIMEOUT");
      if(disposed)throw new System.InvalidOperationException("PC_UI_HOST_DISPOSED");
      int state=Probe(); if(state==1)return;
      if(state==2)throw new System.InvalidOperationException("PC_UI_HOST_PORT_CONFLICT");
      if(owned!=null)StopOwned();
      var launcher=System.IO.Path.Combine(root,"control-center-host","launch.mjs");
      if(!System.IO.File.Exists(launcher))throw new System.InvalidOperationException("PC_UI_HOST_PACKAGE_MISSING");
      var executable=VerifiedNodeRuntime.Resolve(root,node,bundledHash);
      job=CreateJobObject(System.IntPtr.Zero,null);
      if(job==System.IntPtr.Zero)throw new System.InvalidOperationException("PC_UI_HOST_LIFETIME_UNAVAILABLE");
      var info=new ExtendedLimit(); info.Basic.LimitFlags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      var size=System.Runtime.InteropServices.Marshal.SizeOf(typeof(ExtendedLimit));
      var memory=System.Runtime.InteropServices.Marshal.AllocHGlobal(size);
      try { System.Runtime.InteropServices.Marshal.StructureToPtr(info,memory,false);
        if(!SetInformationJobObject(job,9,memory,(uint)size))throw new System.InvalidOperationException("PC_UI_HOST_LIFETIME_UNAVAILABLE");
      } catch { CloseHandle(job); job=System.IntPtr.Zero; throw; }
      finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(memory); }
      try {
        var start=new System.Diagnostics.ProcessStartInfo(executable,"\""+launcher+"\"");
        start.WorkingDirectory=root; start.UseShellExecute=false; start.CreateNoWindow=true;
        start.RedirectStandardOutput=true; start.RedirectStandardError=true;
        start.EnvironmentVariables["PORT"]=port.ToString();
        owned=System.Diagnostics.Process.Start(start);
        if(!AssignProcessToJobObject(job,owned.Handle))throw new System.InvalidOperationException("PC_UI_HOST_LIFETIME_UNAVAILABLE");
        owned.BeginOutputReadLine(); owned.BeginErrorReadLine(); // Drain without retaining secrets in UI logs.
        var timer=System.Diagnostics.Stopwatch.StartNew();
        while(timer.ElapsedMilliseconds<8000) {
          if(owned.HasExited)throw new System.InvalidOperationException("PC_UI_HOST_START_FAILED");
          if(Probe()==1)return;
          System.Threading.Thread.Sleep(100);
        }
        throw new System.InvalidOperationException("PC_UI_HOST_START_TIMEOUT");
      } catch { StopOwned(); throw; }
      } finally { if(acquired)mutex.ReleaseMutex(); }
      }
    }
  }
  private void StopOwned() {
    if(owned!=null) { try { if(!owned.HasExited) { owned.Kill(); owned.WaitForExit(3000); } } catch { }
      owned.Dispose(); owned=null; }
    if(job!=System.IntPtr.Zero) { CloseHandle(job); job=System.IntPtr.Zero; }
  }
  public void Dispose() { lock(gate) { disposed=true; StopOwned(); } }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct BasicLimit { public long User,JobTime; public uint LimitFlags; public System.UIntPtr Min,Max; public uint Active; public System.UIntPtr Affinity; public uint Priority,Scheduling; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct IoCounters { public ulong Read,Write,Other,ReadBytes,WriteBytes,OtherBytes; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  private struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public System.UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
  [System.Runtime.InteropServices.DllImport("kernel32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)] private static extern System.IntPtr CreateJobObject(System.IntPtr attributes,string name);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(System.IntPtr handle,int kind,System.IntPtr info,uint length);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(System.IntPtr job,System.IntPtr process);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool CloseHandle(System.IntPtr handle);
}
`;}
