param(
  [ValidatePattern('^[A-Za-z0-9._-]{2,128}$')]
  [string]$PipeName = 'JARVISCoreCredentialProbe',
  [ValidatePattern('^[A-Za-z0-9._-]{2,128}$')]
  [string]$ServiceName = 'JARVISCoreRuntime',
  [ValidatePattern('^S-1-5-80-(?:\d+-){4}\d+$')]
  [string]$ServiceSid = '',
  [ValidatePattern('^[A-Za-z0-9._-]{2,128}$')]
  [string]$ClientPipeName = '',
  [ValidateRange(1, 1048576)]
  [int]$MaximumPayloadBytes = 65536,
  [ValidateRange(20, 5000)]
  [int]$Iterations = 100
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or [IntPtr]::Size -ne 8) { throw 'A_WINDOWS_X64_HOST_REQUIRED' }

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class JarvisNamedPipeProbe
{
    const uint PIPE_ACCESS_DUPLEX = 0x00000003;
    const uint PIPE_TYPE_MESSAGE = 0x00000004;
    const uint PIPE_READMODE_MESSAGE = 0x00000002;
    const uint PIPE_WAIT = 0x00000000;
    const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
    const uint GENERIC_READ = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint OPEN_EXISTING = 3;
    const uint PIPE_UNLIMITED_INSTANCES = 255;
    const uint ERROR_PIPE_CONNECTED = 535;
    const uint ERROR_MORE_DATA = 234;
    const uint ERROR_ACCESS_DENIED = 5;
    const uint DACL_SECURITY_INFORMATION = 0x00000004;
    const uint SE_FILE_OBJECT = 1;

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision,
        out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision,
        uint information, out IntPtr text, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint GetSecurityInfo(IntPtr handle, uint objectType, uint securityInfo,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information,
        int informationLength, out int returnLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances,
        uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SECURITY_ATTRIBUTES securityAttributes);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ConnectNamedPipe(IntPtr pipe, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetNamedPipeHandleState(IntPtr pipe, ref uint mode, IntPtr maxCollectionCount, IntPtr collectDataTimeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(IntPtr handle, byte[] buffer, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr handle, byte[] buffer, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);

    public static string CurrentLogonSid()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "A_PROCESS_TOKEN_OPEN_FAILED");
        IntPtr groups = IntPtr.Zero;
        try
        {
            int bytes;
            GetTokenInformation(token, 2, IntPtr.Zero, 0, out bytes);
            groups = Marshal.AllocHGlobal(bytes);
            if (!GetTokenInformation(token, 2, groups, bytes, out bytes))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "A_TOKEN_GROUPS_READ_FAILED");
            int count = Marshal.ReadInt32(groups);
            const int firstGroupOffset = 8;
            const int groupStride = 16;
            for (int index = 0; index < count; index++)
            {
                int offset = firstGroupOffset + index * groupStride;
                IntPtr sid = Marshal.ReadIntPtr(groups, offset);
                uint attributes = unchecked((uint)Marshal.ReadInt32(groups, offset + IntPtr.Size));
                if ((attributes & 0xC0000000) == 0xC0000000)
                    return new SecurityIdentifier(sid).Value;
            }
        }
        finally { if (groups != IntPtr.Zero) Marshal.FreeHGlobal(groups); CloseHandle(token); }
        throw new InvalidOperationException("A_LOGON_SID_NOT_FOUND");
    }

    public static string ReadActualPipeSddl(IntPtr pipe)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint status = GetSecurityInfo(pipe, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (status != 0) throw new Win32Exception((int)status, "A_PIPE_DACL_QUERY_FAILED");
        IntPtr text = IntPtr.Zero;
        try
        {
            uint size;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1,
                DACL_SECURITY_INFORMATION, out text, out size)) throw new Win32Exception(Marshal.GetLastWin32Error(), "A_PIPE_SDDL_CONVERSION_FAILED");
            return Marshal.PtrToStringUni(text);
        }
        finally { if (text != IntPtr.Zero) LocalFree(text); if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }

    static IntPtr CreateServer(string name, string logonSid, string serviceSid, uint bufferSize)
    {
        // The interactive logon gets specific data/metadata rights only. Do not grant
        // FILE_APPEND_DATA, which aliases FILE_CREATE_PIPE_INSTANCE on named pipes.
        string sddl = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x0012019B;;;" + logonSid
            + ")(A;;0x0012019F;;;" + serviceSid + ")";
        IntPtr descriptor;
        uint descriptorSize;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, out descriptorSize))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "A_PIPE_SDDL_CREATE_FAILED");
        try
        {
            var attributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                lpSecurityDescriptor = descriptor, bInheritHandle = 0 };
            IntPtr pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1, bufferSize, bufferSize, 0, ref attributes);
            if (pipe == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "A_PIPE_CREATE_FAILED");
            return pipe;
        }
        finally { LocalFree(descriptor); }
    }

    static bool UnauthorizedLogonSidDenied(string name, string serviceSid)
    {
        string sddl = "D:P(A;;GA;;;SY)(A;;GRGW;;;" + serviceSid + ")";
        IntPtr descriptor;
        uint descriptorSize;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, out descriptorSize))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "A_DENY_CONTROL_SDDL_CREATE_FAILED");
        IntPtr server = IntPtr.Zero;
        try
        {
            var attributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                lpSecurityDescriptor = descriptor, bInheritHandle = 0 };
            server = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1, 1024, 1024, 0, ref attributes);
            if (server == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "A_DENY_CONTROL_PIPE_CREATE_FAILED");
            IntPtr client = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero,
                OPEN_EXISTING, 0, IntPtr.Zero);
            if (client != new IntPtr(-1)) { CloseHandle(client); return false; }
            return (uint)Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED;
        }
        finally
        {
            if (server != IntPtr.Zero && server != new IntPtr(-1)) CloseHandle(server);
            LocalFree(descriptor);
        }
    }

    static bool Connect(IntPtr pipe)
    {
        if (ConnectNamedPipe(pipe, IntPtr.Zero)) return true;
        return (uint)Marshal.GetLastWin32Error() == ERROR_PIPE_CONNECTED;
    }

    static uint PipeAceMask(string sddl, string sid)
    {
        var match = Regex.Match(sddl, @"\(A;;(0x[0-9a-fA-F]+);;;" + Regex.Escape(sid) + @"\)");
        if (!match.Success) return 0;
        return Convert.ToUInt32(match.Groups[1].Value.Substring(2), 16);
    }

    static byte[] ReadMessageBounded(IntPtr handle, int maximum, out bool oversized)
    {
        var result = new MemoryStream();
        var chunk = new byte[8192];
        oversized = false;
        while (true)
        {
            uint read;
            bool complete = ReadFile(handle, chunk, (uint)chunk.Length, out read, IntPtr.Zero);
            int error = complete ? 0 : Marshal.GetLastWin32Error();
            if (!complete && error != ERROR_MORE_DATA) throw new Win32Exception(error, "A_PIPE_READ_FAILED");
            if (!oversized)
            {
                if (result.Length + read > maximum) { oversized = true; result.SetLength(0); }
                else result.Write(chunk, 0, (int)read);
            }
            if (complete) return oversized ? null : result.ToArray();
        }
    }

    static void WriteMessage(IntPtr handle, byte[] data)
    {
        uint written;
        if (!WriteFile(handle, data, (uint)data.Length, out written, IntPtr.Zero) || written != data.Length)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "A_PIPE_WRITE_FAILED");
    }

    static IntPtr OpenClient(string name)
    {
        IntPtr client = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero,
            OPEN_EXISTING, 0, IntPtr.Zero);
        if (client == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "A_PIPE_CLIENT_OPEN_FAILED");
        uint mode = PIPE_READMODE_MESSAGE;
        if (!SetNamedPipeHandleState(client, ref mode, IntPtr.Zero, IntPtr.Zero))
        {
            CloseHandle(client);
            throw new Win32Exception(Marshal.GetLastWin32Error(), "A_PIPE_CLIENT_MODE_FAILED");
        }
        return client;
    }

    static byte[] ReadClientMessage(IntPtr client, int maximum)
    {
        bool oversized;
        byte[] message = ReadMessageBounded(client, maximum, out oversized);
        if (oversized) throw new InvalidOperationException("A_PIPE_ECHO_RESPONSE_OVERSIZED");
        return message;
    }

    static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    public static string RunClient(string pipeName, int maximumPayloadBytes, int iterations)
    {
        IntPtr client = OpenClient("\\\\.\\pipe\\" + pipeName);
        try
        {
            byte[] probe = Encoding.UTF8.GetBytes("JARVIS-NAMED-PIPE-PROBE-v1");
            int warmups = Math.Min(10, Math.Max(1, iterations / 10));
            var samples = new List<double>();
            bool echoMatches = true;
            for (int index = 0; index < iterations; index++)
            {
                var timer = Stopwatch.StartNew();
                WriteMessage(client, probe);
                byte[] response = ReadClientMessage(client, maximumPayloadBytes);
                timer.Stop();
                echoMatches &= StructuralComparisons.StructuralEqualityComparer.Equals(probe, response);
                if (index >= warmups) samples.Add(timer.Elapsed.TotalMilliseconds);
            }
            samples.Sort();
            byte[] oversized = new byte[maximumPayloadBytes + 1];
            for (int index = 0; index < oversized.Length; index++) oversized[index] = 0x41;
            uint ignored;
            if (!WriteFile(client, oversized, (uint)oversized.Length, out ignored, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "A_PIPE_OVERSIZED_SEND_FAILED");
            return "{\"clientProcessId\":" + Process.GetCurrentProcess().Id.ToString() +
                ",\"messageEchoMatches\":" + (echoMatches ? "true" : "false") +
                ",\"measuredIterations\":" + samples.Count.ToString() +
                ",\"roundTripP50Ms\":" + Percentile(samples, 0.50).ToString(System.Globalization.CultureInfo.InvariantCulture) +
                ",\"roundTripP95Ms\":" + Percentile(samples, 0.95).ToString(System.Globalization.CultureInfo.InvariantCulture) + "}";
        }
        finally { CloseHandle(client); }
    }

    static double Percentile(List<double> sorted, double percentile)
    {
        int index = Math.Max(0, (int)Math.Ceiling(sorted.Count * percentile) - 1);
        return Math.Round(sorted[index], 4);
    }

    public static object Run(string pipeName, string serviceName, string serviceSid, string scriptPath, int maximumPayloadBytes, int iterations)
    {
        string logonSid = CurrentLogonSid();
        string pipePath = "\\\\.\\pipe\\" + pipeName;
        var ready = new ManualResetEventSlim(false);
        Exception serverError = null;
        string actualSddl = null;
        bool oversizedRejected = false;
        string childOutput = null;
        int clientPid = 0;
        using (var child = new Process())
        {
            child.StartInfo = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + QuoteArgument(scriptPath) +
                    " -ClientPipeName " + QuoteArgument(pipeName) + " -Iterations " + iterations.ToString() +
                    " -MaximumPayloadBytes " + maximumPayloadBytes.ToString(),
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            child.StartInfo.EnvironmentVariables.Clear();
            child.StartInfo.EnvironmentVariables["OS"] = "Windows_NT";
            child.StartInfo.EnvironmentVariables["SystemRoot"] = Environment.GetEnvironmentVariable("SystemRoot");
            child.StartInfo.EnvironmentVariables["WINDIR"] = Environment.GetEnvironmentVariable("WINDIR");
            child.StartInfo.EnvironmentVariables["PATH"] = Path.GetDirectoryName(child.StartInfo.FileName);
            child.StartInfo.EnvironmentVariables["TEMP"] = Path.GetTempPath();
            child.StartInfo.EnvironmentVariables["TMP"] = Path.GetTempPath();
        var serverThread = new Thread(() => {
            IntPtr pipe = IntPtr.Zero;
            try
            {
                pipe = CreateServer(pipePath, logonSid, serviceSid, (uint)Math.Min(maximumPayloadBytes, 65536));
                actualSddl = ReadActualPipeSddl(pipe);
                if (!child.Start()) throw new InvalidOperationException("A_PIPE_CLIENT_PROCESS_START_FAILED");
                ready.Set();
                if (!Connect(pipe)) throw new InvalidOperationException("A_PIPE_CONNECT_FAILED");
                uint observedClientPid;
                if (!GetNamedPipeClientProcessId(pipe, out observedClientPid)) throw new Win32Exception(Marshal.GetLastWin32Error(), "A_PIPE_CLIENT_ID_FAILED");
                clientPid = (int)observedClientPid;
                while (true)
                {
                    bool tooLarge;
                    byte[] received = ReadMessageBounded(pipe, maximumPayloadBytes, out tooLarge);
                    if (tooLarge) { oversizedRejected = true; break; }
                    WriteMessage(pipe, received);
                }
                if (!oversizedRejected) throw new InvalidOperationException("A_PIPE_OVERSIZED_MESSAGE_ACCEPTED");
            }
            catch (Exception error) { serverError = error; ready.Set(); }
            finally { if (pipe != IntPtr.Zero && pipe != new IntPtr(-1)) CloseHandle(pipe); }
        });
        serverThread.IsBackground = true;
        serverThread.Start();
        if (!ready.Wait(10000)) throw new TimeoutException("A_PIPE_SERVER_READY_TIMEOUT");
        if (serverError != null) throw serverError;
        if (!child.WaitForExit(30000)) { try { child.Kill(); } catch {} throw new TimeoutException("A_PIPE_CLIENT_FINISH_TIMEOUT"); }
        childOutput = child.StandardOutput.ReadToEnd();
        string childError = child.StandardError.ReadToEnd();
        if (child.ExitCode != 0) throw new InvalidOperationException("A_PIPE_CLIENT_PROCESS_FAILED_" + child.ExitCode.ToString() + "_" + childError);
        if (!serverThread.Join(10000)) throw new TimeoutException("A_PIPE_SERVER_FINISH_TIMEOUT");
        if (serverError != null) throw serverError;
        var pidMatch = Regex.Match(childOutput, "\\\"clientProcessId\\\":(\\d+)");
        var echoMatch = Regex.Match(childOutput, "\\\"messageEchoMatches\\\":(true|false)");
        var countMatch = Regex.Match(childOutput, "\\\"measuredIterations\\\":(\\d+)");
        var p50Match = Regex.Match(childOutput, "\\\"roundTripP50Ms\\\":([0-9.]+)");
        var p95Match = Regex.Match(childOutput, "\\\"roundTripP95Ms\\\":([0-9.]+)");
        if (!pidMatch.Success || !echoMatch.Success || !countMatch.Success || !p50Match.Success || !p95Match.Success)
            throw new InvalidOperationException("A_PIPE_CLIENT_METRICS_INVALID");
        int childReportedPid = Int32.Parse(pidMatch.Groups[1].Value);
        bool echoMatches = echoMatch.Groups[1].Value == "true";
        int measuredIterations = Int32.Parse(countMatch.Groups[1].Value);
        double p50 = Double.Parse(p50Match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
        double p95 = Double.Parse(p95Match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
        if (clientPid != childReportedPid) throw new InvalidOperationException("A_PIPE_CLIENT_PID_MISMATCH");
            bool unauthorizedSidDenied = UnauthorizedLogonSidDenied(pipePath + "_Denied", serviceSid);
            return new {
                pipeName = "<ephemeral-pipe>",
                serviceName,
                clientProcessIdObserved = clientPid != 0,
                clientProcessIdDistinct = clientPid != Process.GetCurrentProcess().Id,
                actualPipeSddl = actualSddl.Replace(logonSid, "<logon-sid>").Replace(serviceSid, "<service-sid>"),
                logonSidInActualDacl = actualSddl.IndexOf(logonSid, StringComparison.OrdinalIgnoreCase) >= 0,
                serviceSidInActualDacl = actualSddl.IndexOf(serviceSid, StringComparison.OrdinalIgnoreCase) >= 0,
                logonSidCanCreatePipeInstance = (PipeAceMask(actualSddl, logonSid) & 0x00000004) != 0,
                serviceSidCanCreatePipeInstance = (PipeAceMask(actualSddl, serviceSid) & 0x00000004) != 0,
                everyoneInActualDacl = actualSddl.IndexOf("S-1-1-0", StringComparison.OrdinalIgnoreCase) >= 0,
                anonymousInActualDacl = actualSddl.IndexOf("S-1-5-7", StringComparison.OrdinalIgnoreCase) >= 0,
                remoteClientRejectFlagRequested = true,
                localClientConnected = true,
                messageEchoMatches = echoMatches,
                iterations,
                warmupIterations = Math.Min(10, Math.Max(1, iterations / 10)),
                measuredIterations,
                roundTripP50Ms = p50,
                roundTripP95Ms = p95,
                oversizedMessageRejected = oversizedRejected,
                clientWithoutAllowedSidDenied = unauthorizedSidDenied,
                serviceIdentityAccessTested = false,
                remoteClientAttempted = false,
                sameUserMalwareIsolated = false
            };
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
if ($ClientPipeName) {
  [JarvisNamedPipeProbe]::RunClient($ClientPipeName, $MaximumPayloadBytes, $Iterations)
  exit 0
}
$pipeName = "JarvisCredentialProbe_$([Guid]::NewGuid().ToString('N'))"
$serviceControlPath = Join-Path $env:SystemRoot 'System32\sc.exe'
$resolvedServiceSid = $ServiceSid
if (-not $resolvedServiceSid) {
  $serviceSidOutput = & $serviceControlPath showsid $ServiceName 2>&1 | Out-String
  $serviceSidMatch = [Regex]::Match($serviceSidOutput, '(?i)(S-1-5-80-(?:\d+-){4}\d+)')
  if (-not $serviceSidMatch.Success) { throw 'A_SERVICE_SID_RESOLUTION_FAILED' }
  $resolvedServiceSid = $serviceSidMatch.Groups[1].Value
}
$result = [JarvisNamedPipeProbe]::Run($pipeName, $ServiceName, $resolvedServiceSid, $PSCommandPath,
  $MaximumPayloadBytes, $Iterations)
if (-not $result.localClientConnected -or -not $result.messageEchoMatches -or -not $result.oversizedMessageRejected -or
  -not $result.clientWithoutAllowedSidDenied -or
  -not $result.logonSidInActualDacl -or -not $result.serviceSidInActualDacl -or
  $result.logonSidCanCreatePipeInstance -or -not $result.serviceSidCanCreatePipeInstance -or
  $result.everyoneInActualDacl -or $result.anonymousInActualDacl) {
  throw 'A_NAMED_PIPE_PROBE_ASSERTION_FAILED'
}
$result | ConvertTo-Json -Depth 5
