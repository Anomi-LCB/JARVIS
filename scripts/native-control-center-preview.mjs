// Disposable native QA harness: synthetic upstream, separate preferences/WebView storage,
// original window/action implementation; not an install or release promotion.
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeInstallerPackage} from '../apps/pc-agent/src/install/installer-packager.js';
import {loadPcAgentInstallConfig} from '../apps/pc-agent/src/install/service-planner.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
if(process.platform!=='win32')throw new Error('Windows native preview only');
const outputDir=resolve('artifacts/native-control-center-preview-20261003/package');
let rejectedWrites=0,readCalls=0;
const upstream=createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;res.setHeader('content-type','application/json');
 const json=value=>res.end(JSON.stringify(value));
 if(req.method!=='GET'){rejectedWrites++;res.statusCode=403;return json({success:false,error:{code:'QA_READ_ONLY'}});}
 readCalls++;
 if(pathname==='/pc/health')return json({status:'ok',module:'B_PC_AGENT'});
 if(pathname==='/core/health')return json({status:'running',module:'A_CORE'});
 if(pathname==='/core/security/trust')return json({mode:'trusted'});
 if(pathname==='/core/missions')return json({items:[],status:{executionMode:'standard'}});
 if(pathname.startsWith('/core/'))return json({items:[]});
 res.statusCode=404;json({success:false,error:{code:'QA_NOT_IMPLEMENTED'}});
});
await listenOnFetchSafePort(upstream,{host:'127.0.0.1',port:0});
const base=`http://127.0.0.1:${upstream.address().port}`;
await writeInstallerPackage({...await loadPcAgentInstallConfig(),outputDir});
let source=await readFile(join(outputDir,'tray-agent.cs'),'utf8');
source=source.replace('public static void Main(string[] args)','public static void OriginalMainNotUsed(string[] args)')
 .replace('Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JARVIS", "pc-agent-ui.settings")','Path.Combine(root, "qa-ui.settings")')
 .replace('Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JARVIS", "desktop-browser")','Path.Combine(root, "qa-browser")');
const manifest=JSON.parse(await readFile(join(outputDir,'package-manifest.json'),'utf8'));
source+=`\npublic static class NativePreviewRunner {
 [STAThread] public static void Main() {
  var root=AppDomain.CurrentDomain.BaseDirectory;
  Environment.SetEnvironmentVariable("JARVIS_CORE_API_URL","${base}/core");
  Environment.SetEnvironmentVariable("JARVIS_PC_AGENT_API_URL","${base}/pc");
  Environment.SetEnvironmentVariable("JARVIS_BRIDGE_API_URL","${base}/bridge");
  Environment.SetEnvironmentVariable("JARVIS_CORE_ADMIN_TOKEN","isolated-native-preview");
  Environment.SetEnvironmentVariable("JARVIS_PC_AGENT_API_TOKEN","isolated-native-preview");
  var application=new Application(); application.ShutdownMode=ShutdownMode.OnExplicitShutdown;
  var panel=new JarvisControlWindow(root,"${base}/pc","JarvisPcAgentIsolatedValidation","JARVIS 격리 화면 검증","http://127.0.0.1:41730",
   "${manifest.fileIntegrity['tray-agent.xaml'].sha256}",delegate(string title,string text,WinForms.ToolTipIcon icon){},new Icon(Path.Combine(root,"jarvis.ico")));
  panel.ShowPanel(); application.Run();
 }
}\n`;
await writeFile(join(outputDir,'tray-agent.cs'),source,'utf8');
await promisify(execFile)('powershell.exe',['-NoProfile','-File',join(outputDir,'build-tray-exe.ps1')],{windowsHide:true});
console.log(JSON.stringify({executable:join(outputDir,'JarvisPcAgentTray.exe'),fixture:'native window/actions with isolated preference/browser paths and synthetic read-only upstream',base}));
process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='quit'){upstream.closeAllConnections();upstream.close(()=>{console.log(JSON.stringify({rejectedWrites,readCalls}));process.exit(0);});}});
process.stdin.on('end',()=>{upstream.closeAllConnections();upstream.close(()=>process.exit(0));});
