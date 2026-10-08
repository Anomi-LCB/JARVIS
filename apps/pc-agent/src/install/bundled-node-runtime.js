import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
export function readBundledNodeRuntime(input){
 if(input==null)return {files:{},sha256:null};
 const {executablePath,licensePath,expectedSha256,version}=input;
 if(!isAbsolute(executablePath??'')||!isAbsolute(licensePath??'')||!/^v(?:2[4-9]|[3-9]\d)\.\d+\.\d+$/u.test(version??'')||!/^[a-f0-9]{64}$/u.test(expectedSha256??''))throw new Error('PC_NODE_BUNDLE_INPUT_INVALID');
 for(const [path,limit] of [[executablePath,128*1024*1024],[licensePath,1024*1024]]){
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw new Error('PC_NODE_BUNDLE_FILE_INVALID');
 }
 const binary=readFileSync(executablePath),license=readFileSync(licensePath,'utf8');
 const sha256=createHash('sha256').update(binary).digest('hex');
 if(sha256!==expectedSha256||binary.length<64||binary[0]!==0x4d||binary[1]!==0x5a)throw new Error('PC_NODE_BUNDLE_INTEGRITY_FAILED');
 const pe=binary.readUInt32LE(0x3c);
 if(pe+24>binary.length||binary.readUInt32LE(pe)!==0x00004550||binary.readUInt16LE(pe+4)!==0x8664)throw new Error('PC_NODE_BUNDLE_ARCHITECTURE_INVALID');
 if(!license.includes('Node.js is licensed for use as follows:')||!license.includes('externally maintained libraries'))throw new Error('PC_NODE_BUNDLE_LICENSE_INVALID');
 return {sha256,files:{'runtime/node.exe':binary,'runtime/Node-LICENSE.txt':license,'runtime/node-provenance.json':JSON.stringify({version,sha256,platform:'win32',architecture:'x64',sourceVerification:'caller-pinned-sha256',licenseSource:`https://github.com/nodejs/node/blob/${version}/LICENSE`,releaseSignatureVerified:false},null,2)}};
}
export function renderVerifiedNodeRuntimeSource(){return String.raw`
public static class VerifiedNodeRuntime {
 public static string Resolve(string root,string external,string expected) {
  if(!System.String.IsNullOrEmpty(expected)) {
   var path=System.IO.Path.Combine(root,"runtime","node.exe");
   if(!System.IO.File.Exists(path))throw new System.InvalidOperationException("PC_NODE_BUNDLE_MISSING");
   if((System.IO.File.GetAttributes(path)&System.IO.FileAttributes.ReparsePoint)!=0 ||
      (System.IO.File.GetAttributes(System.IO.Path.GetDirectoryName(path))&System.IO.FileAttributes.ReparsePoint)!=0)throw new System.InvalidOperationException("PC_NODE_BUNDLE_LINK_DENIED");
   using(var stream=System.IO.File.OpenRead(path))using(var sha=System.Security.Cryptography.SHA256.Create()) {
    var actual=System.BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
    if(actual!=expected)throw new System.InvalidOperationException("PC_NODE_BUNDLE_INTEGRITY_FAILED");
   }
   return path;
  }
  if(!System.IO.Path.IsPathRooted(external)||!System.IO.File.Exists(external))throw new System.InvalidOperationException("PC_UI_HOST_NODE_MISSING");
  return external;
 }
}
`;}
