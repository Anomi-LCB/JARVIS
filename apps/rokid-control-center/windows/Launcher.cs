using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace RokidControlCenter
{
    static class Program
    {
        private const int Port = 4785;
        private const string AppVersion = "0.2.2";
        private const string PayloadResourceName = "RokidControlCenter.Payload.zip";
        private const string PayloadHashResourceName = "RokidControlCenter.Payload.sha256";

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool selfTest = HasArgument("--self-test");
            Process server = null;
            bool startedServer = false;
            bool serverHandedOff = false;

            try
            {
                string executableRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                bool portableMode = IsRuntimeComplete(executableRoot, null);
                string runtimeRoot = portableMode ? executableRoot : EnsureEmbeddedRuntime();
                string dataRoot = portableMode
                    ? Path.Combine(executableRoot, "data")
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RokidControlCenter", "data");
                Directory.CreateDirectory(dataRoot);

                string nodePath = Path.Combine(runtimeRoot, "runtime", "node.exe");
                string serverPath = Path.Combine(runtimeRoot, "app", "src", "server.mjs");
                string adbPath = Path.Combine(runtimeRoot, "tools", "adb", "adb.exe");
                string url = "http://127.0.0.1:" + Port;

                if (!IsHealthy(url))
                {
                    server = StartLocalServer(nodePath, serverPath, adbPath, runtimeRoot, dataRoot);
                    startedServer = true;
                    if (!WaitForServer(url, 20000))
                    {
                        throw new InvalidOperationException("로컬 제어 서버가 시작되지 않았습니다. 포트 4785 사용 여부를 확인하세요.");
                    }
                }

                if (selfTest)
                {
                    Environment.ExitCode = 0;
                    return;
                }

                Process appWindow = OpenAppWindow(url);
                serverHandedOff = startedServer && appWindow != null;
                if (appWindow != null)
                {
                    while (!appWindow.WaitForExit(2000))
                    {
                        if (IsHealthy(url)) continue;
                        if (server != null && !server.HasExited)
                        {
                            try { server.Kill(); server.WaitForExit(5000); }
                            catch { }
                        }
                        server = StartLocalServer(nodePath, serverPath, adbPath, runtimeRoot, dataRoot);
                        startedServer = true;
                        serverHandedOff = true;
                        WaitForServer(url, 20000);
                    }
                }
            }
            catch (Exception error)
            {
                if (selfTest)
                {
                    Environment.ExitCode = 2;
                    return;
                }
                MessageBox.Show(error.Message, "Rokid 제어 센터", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                if (startedServer && !serverHandedOff && server != null && !server.HasExited)
                {
                    try
                    {
                        server.Kill();
                        server.WaitForExit(5000);
                    }
                    catch { }
                }
            }
        }

        static string EnsureEmbeddedRuntime()
        {
            string payloadHash = ReadEmbeddedText(PayloadHashResourceName).Trim().ToLowerInvariant();
            if (!IsSha256(payloadHash)) throw new InvalidDataException("내장 실행 payload 해시가 올바르지 않습니다.");

            string runtimeBase = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RokidControlCenter",
                "runtime");
            string targetRoot = Path.Combine(runtimeBase, AppVersion + "-" + payloadHash.Substring(0, 16));
            if (IsRuntimeComplete(targetRoot, payloadHash)) return targetRoot;

            Directory.CreateDirectory(runtimeBase);
            using (Mutex extractionMutex = new Mutex(false, @"Local\RokidControlCenter.Payload.v0_2_2"))
            {
                bool lockHeld = false;
                try
                {
                    try { lockHeld = extractionMutex.WaitOne(TimeSpan.FromSeconds(30)); }
                    catch (AbandonedMutexException) { lockHeld = true; }
                    if (!lockHeld) throw new TimeoutException("내장 실행 파일 준비 작업이 끝나기를 기다리는 중 시간 초과가 발생했습니다.");
                    if (IsRuntimeComplete(targetRoot, payloadHash)) return targetRoot;

                    string stagingRoot = targetRoot + ".staging-" + Process.GetCurrentProcess().Id;
                    DeleteDirectoryWithin(runtimeBase, stagingRoot);
                    Directory.CreateDirectory(stagingRoot);
                    try
                    {
                        ExtractEmbeddedPayload(stagingRoot);
                        if (!IsRuntimeComplete(stagingRoot, null)) throw new InvalidDataException("내장 실행 payload에 필수 파일이 없습니다.");
                        File.WriteAllText(Path.Combine(stagingRoot, ".payload.sha256"), payloadHash);
                        DeleteDirectoryWithin(runtimeBase, targetRoot);
                        Directory.Move(stagingRoot, targetRoot);
                    }
                    finally
                    {
                        DeleteDirectoryWithin(runtimeBase, stagingRoot);
                    }
                }
                finally
                {
                    if (lockHeld) extractionMutex.ReleaseMutex();
                }
            }

            if (!IsRuntimeComplete(targetRoot, payloadHash)) throw new InvalidDataException("내장 실행 파일 검증에 실패했습니다.");
            return targetRoot;
        }

        static void ExtractEmbeddedPayload(string destinationRoot)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream payload = assembly.GetManifestResourceStream(PayloadResourceName))
            {
                if (payload == null) throw new FileNotFoundException("단일 EXE에 실행 payload가 없습니다.");
                using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read, false))
                {
                    string safeRoot = Path.GetFullPath(destinationRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                        + Path.DirectorySeparatorChar;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string relativePath = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        string destinationPath = Path.GetFullPath(Path.Combine(destinationRoot, relativePath));
                        if (!destinationPath.StartsWith(safeRoot, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidDataException("내장 payload에 허용되지 않은 경로가 있습니다.");
                        }

                        if (String.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(destinationPath);
                            continue;
                        }

                        string parent = Path.GetDirectoryName(destinationPath);
                        if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                        using (Stream input = entry.Open())
                        using (FileStream output = new FileStream(destinationPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            input.CopyTo(output);
                        }
                    }
                }
            }
        }

        static bool IsRuntimeComplete(string root, string expectedHash)
        {
            if (String.IsNullOrEmpty(root)) return false;
            if (!File.Exists(Path.Combine(root, "runtime", "node.exe"))) return false;
            if (!File.Exists(Path.Combine(root, "app", "src", "server.mjs"))) return false;
            if (!File.Exists(Path.Combine(root, "tools", "adb", "adb.exe"))) return false;
            if (expectedHash == null) return true;
            string marker = Path.Combine(root, ".payload.sha256");
            if (!File.Exists(marker)) return false;
            return String.Equals(File.ReadAllText(marker).Trim(), expectedHash, StringComparison.OrdinalIgnoreCase);
        }

        static void DeleteDirectoryWithin(string allowedRoot, string candidate)
        {
            string root = Path.GetFullPath(allowedRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            string target = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("실행 파일 정리 경로가 허용된 범위를 벗어났습니다.");
            }
            if (Directory.Exists(target)) Directory.Delete(target, true);
        }

        static string ReadEmbeddedText(string resourceName)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (stream == null) throw new FileNotFoundException("단일 EXE에 payload 메타데이터가 없습니다.");
                using (StreamReader reader = new StreamReader(stream)) return reader.ReadToEnd();
            }
        }

        static bool IsSha256(string value)
        {
            if (value == null || value.Length != 64) return false;
            foreach (char character in value)
            {
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
            }
            return true;
        }

        static Process OpenAppWindow(string url)
        {
            string[] edgeCandidates = new string[] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe")
            };
            foreach (string edge in edgeCandidates)
            {
                if (!File.Exists(edge)) continue;
                string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RokidControlCenter", "EdgeProfile");
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = edge;
                info.Arguments = "--app=" + Quote(url) + " --user-data-dir=" + Quote(profile) + " --no-first-run --disable-features=msEdgeSidebarV2";
                info.UseShellExecute = false;
                return Process.Start(info);
            }
            ProcessStartInfo fallback = new ProcessStartInfo();
            fallback.FileName = url;
            fallback.UseShellExecute = true;
            return Process.Start(fallback);
        }

        static Process StartLocalServer(string nodePath, string serverPath, string adbPath, string runtimeRoot, string dataRoot)
        {
            ProcessStartInfo serverInfo = new ProcessStartInfo();
            serverInfo.FileName = nodePath;
            serverInfo.Arguments = Quote(serverPath)
                + " --host 127.0.0.1 --port " + Port
                + " --portable-root " + Quote(runtimeRoot)
                + " --data-root " + Quote(dataRoot)
                + " --idle-exit-ms 300000";
            serverInfo.WorkingDirectory = runtimeRoot;
            serverInfo.UseShellExecute = false;
            serverInfo.CreateNoWindow = true;
            serverInfo.WindowStyle = ProcessWindowStyle.Hidden;
            serverInfo.EnvironmentVariables["ROKID_ADB_PATH"] = adbPath;
            return Process.Start(serverInfo);
        }

        static bool WaitForServer(string url, int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                if (IsHealthy(url)) return true;
                Thread.Sleep(250);
                waited += 250;
            }
            return false;
        }

        static bool IsHealthy(string url)
        {
            try
            {
                using (WebClient client = new WebClient())
                {
                    string response = client.DownloadString(url + "/api/health");
                    return response.Contains("rokid-control-center-v1");
                }
            }
            catch { return false; }
        }

        static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        static bool HasArgument(string expected)
        {
            foreach (string argument in Environment.GetCommandLineArgs())
            {
                if (String.Equals(argument, expected, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }
    }
}
