import {spawn, execFile} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error(code), {code});
export function nativeFailureRecovery(failure) {
  const receipt=failure?.nativeRecovery;
  if(receipt?.version!==1||!['activation-unconfirmed','owned-guarded','rendered'].includes(receipt.phase)
    ||typeof receipt.activationGapUnverified!=='boolean'||typeof receipt.cleanupConfirmed!=='boolean') return null;
  const safe={version:1,phase:receipt.phase,activationGapUnverified:receipt.activationGapUnverified,cleanupConfirmed:receipt.cleanupConfirmed,
    autoRetryAllowed:false,executionAuthority:false};
  return safe;
}
const cleanupScript = 'param([string]$TaskPid,[string]$TaskTicks) $p=Get-Process -Id ([int]$TaskPid) -ErrorAction SilentlyContinue;if($p -and $p.ProcessName -eq "EXCEL" -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $TaskTicks){Stop-Process -Id $p.Id -Force -ErrorAction Stop}';

/** Fixed native export of a generated or preflighted authorized macro-free XLSX.
 * No model-selected script, command, renderer executable or cleanup PID. */
export class NativeWorkbookPdfRenderer {
  constructor({platform=process.platform, timeoutMs=30000, spawnProcess=spawn, cleanupProcess=promisify(execFile)}={}) {
    this.platform=platform; this.timeoutMs=timeoutMs; this.spawnProcess=spawnProcess; this.cleanupProcess=cleanupProcess;
  }

  async render({inputPath, outputPath, expectedSha256, signal, beforePublish}) {
    if(this.platform!=='win32') throw error('EXCEL_PDF_WINDOWS_REQUIRED');
    if(signal?.aborted) throw error('EXCEL_PDF_CANCELLED');
    if(!/^[a-f0-9]{64}$/u.test(expectedSha256??'')) throw error('EXCEL_PDF_SOURCE_HASH_REQUIRED');
    const input=await readFile(inputPath);
    if(digest(input)!==expectedSha256) throw error('EXCEL_PDF_SOURCE_CHANGED');
    const scratch=await mkdtemp(join(tmpdir(),'jarvis-excel-pdf-'));
    const rendered=join(scratch,'export');
    const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    // A parent PowerShell 7 PSModulePath cannot supply Windows PowerShell 5 cmdlets.
    // Use that executable's system modules; never a model-provided module path.
    const nativeEnv={...process.env,PSModulePath:join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')};
    let owned=null, child, timer, cancel, cleanupFailed=false, ownedCleanupConfirmed=false, failureRecovery=null;
    const cleanupOwned=async()=>{
      const encoded=Buffer.from(`& { ${cleanupScript} } '${owned.pid}' '${owned.ticks}'`,'utf16le').toString('base64');
      await this.cleanupProcess(executable,['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{env:nativeEnv,windowsHide:true,timeout:5000,maxBuffer:65536});
      ownedCleanupConfirmed=true;
      owned=null;
    };
    const started=performance.now();
    try {
      await new Promise((accept,reject)=>{
        let text='', reason=null, ended=false, nativeReason=null;
        child=this.spawnProcess(executable,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./native-pdf.ps1',import.meta.url)),
          '-InputPath',resolve(inputPath),'-ExpectedSha256',expectedSha256,'-OutputDirectory',rendered,'-NativeParentProcessId',String(process.pid),'-PdfOnly'],{env:nativeEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
        const stop=code=>{reason=reason??code; child.kill();};
        timer=setTimeout(()=>stop('EXCEL_PDF_TIMEOUT'),this.timeoutMs);
        cancel=()=>stop('EXCEL_PDF_CANCELLED'); signal?.addEventListener('abort',cancel,{once:true});
        // Cancellation may arrive during the awaited source/scratch preflight.
        // Adding a listener to an already-aborted signal does not replay it.
        if(signal?.aborted) cancel();
        child.stdout.on('data',chunk=>{
          text+=chunk.toString();
          const match=text.match(/EXCEL_RENDER_OWNED_PROCESS=(\d+):(\d+)/u);
          if(match) owned={pid:match[1],ticks:match[2]};
          if(text.length>65536) stop('EXCEL_PDF_OUTPUT_LIMIT');
        });
        child.stderr.on('data',chunk=>{const match=chunk.toString().match(/EXCEL_RENDER_[A-Z_]+/u);if(match) nativeReason=match[0];}); // Preserve only fixed machine codes, never raw content.
        child.once('error',()=>{if(!ended){ended=true;reject(error('EXCEL_PDF_LAUNCH_FAILED'));}});
        child.once('close',code=>{if(!ended){ended=true;reason||code!==0?reject(error(reason??nativeReason??'EXCEL_PDF_EXPORT_FAILED')):accept();}});
      });
      const reportBytes=await readFile(join(rendered,'render-report.json'));
      if(reportBytes.length>1024*1024) throw error('EXCEL_PDF_REPORT_LIMIT');
      const native=JSON.parse(reportBytes.toString('utf8').replace(/^\uFEFF/u,''));
      if(native.sourceSha256!==expectedSha256||native.sourceUnchanged!==true||native.readOnly!==true
        ||native.actualRenderingExecuted!==true||native.renderer!=='Microsoft Excel COM'||native.mode!=='pdf-only'
        ||!owned||native.isolatedProcessId!==Number(owned.pid)||native.processGuard?.jobAssigned!==true
        ||native.processGuard?.parentWatchEnabled!==true||native.processGuard?.parentPid!==process.pid
        ||native.processGuard?.startTicks!==owned.ticks) throw error('EXCEL_PDF_RECEIPT_INVALID');
      if(digest(await readFile(inputPath))!==expectedSha256) throw error('EXCEL_PDF_SOURCE_CHANGED');
      const pdfPath=join(rendered,'workbook.pdf'),info=await lstat(pdfPath);
      if(!info.isFile()||info.isSymbolicLink()||info.size<20||info.size>32*1024*1024) throw error('EXCEL_PDF_INVALID');
      const pdf=await readFile(pdfPath);
      if(pdf.subarray(0,5).toString()!=='%PDF-'||!pdf.subarray(-1024).toString('latin1').includes('%%EOF')) throw error('EXCEL_PDF_INVALID');
      clearTimeout(timer); signal?.removeEventListener('abort',cancel);
      await cleanupOwned();
      if(signal?.aborted) throw error('EXCEL_PDF_CANCELLED');
      if(performance.now()-started>this.timeoutMs) throw error('EXCEL_PDF_TIMEOUT');
      await beforePublish?.();
      await writeFile(outputPath,pdf,{flag:'wx'});
      return {status:'passed',requested:true,actualRenderingExecuted:true,visualQualityVerified:false,noRepairPromptVerified:false,
        verificationScope:'native-pdf-export-and-source-preservation',renderer:native.renderer,version:native.version,build:native.build,
        sourceSha256:expectedSha256,sourceUnchanged:true,readOnly:true,pdf:{path:outputPath,sha256:digest(pdf),size:pdf.length},
        durationMs:Math.round(performance.now()-started),chartCount:native.charts.length,
        processGuard:{jobAssigned:true,parentWatchEnabled:true,ownedIdentityBound:true}};
    } catch (failure) {
      // Phase receipts are diagnostics only. They never authorize killing a PID,
      // publishing an output, or claiming that unknown COM activation was cleaned.
      let phase='activation-unconfirmed';
      try {
        const bytes=await readFile(join(rendered,'native-phase.json'));
        if(bytes.length<=4096){const receipt=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u,''));
          if(receipt.version===1&&receipt.sourceSha256===expectedSha256&&['owned-guarded','rendered'].includes(receipt.phase))phase=receipt.phase;}
      } catch {}
      failure.nativeRecovery={version:1,phase,activationGapUnverified:phase==='activation-unconfirmed',cleanupConfirmed:false,
        autoRetryAllowed:false,executionAuthority:false};
      failureRecovery=failure.nativeRecovery;
      throw failure;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort',cancel);
      if(owned) {
        try {await cleanupOwned();}
        catch {cleanupFailed=true;}
      }
      if(failureRecovery)failureRecovery.cleanupConfirmed=ownedCleanupConfirmed&&failureRecovery.phase!=='activation-unconfirmed';
      await rm(scratch,{recursive:true,force:true});
      if(cleanupFailed) throw Object.assign(error('EXCEL_PDF_CLEANUP_UNCONFIRMED'),{nativeRecovery:failureRecovery??{version:1,phase:'activation-unconfirmed',activationGapUnverified:true,cleanupConfirmed:false,autoRetryAllowed:false,executionAuthority:false}});
    }
  }
}
