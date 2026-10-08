import { randomUUID } from 'node:crypto';

// Short-lived, memory-only local downloads. No arbitrary path, disk write or external upload.
export class LocalExportStore {
  constructor({clock=()=>Date.now(),ttlMs=300000,maxEntries=20}={}){this.clock=clock;this.ttlMs=ttlMs;this.maxEntries=maxEntries;this.items=new Map();}
  prune(){for(const [id,item] of this.items)if(item.expiresAt <= this.clock())this.items.delete(id);}
  create(input){
    this.prune();
    if(!input || Object.keys(input).some(key=>!['kind','content'].includes(key)) || !['document-brief','support-reviewed'].includes(input.kind)
      || typeof input.content !== 'string' || Buffer.byteLength(input.content)>256*1024 || !input.content.length)throw Object.assign(new Error('INVALID_EXPORT'),{statusCode:400});
    if(this.items.size>=this.maxEntries)throw Object.assign(new Error('EXPORT_LIMIT'),{statusCode:429});
    const id=randomUUID(),filename=input.kind==='document-brief'?'jarvis-document-brief.md':'jarvis-support-reviewed.json';
    this.items.set(id,{content:input.content,filename,expiresAt:this.clock()+this.ttlMs});
    return {url:`/api/local/exports/${id}`,filename,expiresInSeconds:Math.floor(this.ttlMs/1000),externalUpload:false};
  }
  get(id){this.prune();return this.items.get(id)??null;}
}
