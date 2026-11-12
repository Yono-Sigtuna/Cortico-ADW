import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
async function service(){const mod=await import('../../apps/household/service.ts').catch(()=>null);expect(mod?.HouseholdService).toBeTypeOf('function');return mod!.HouseholdService;}
function root(){const r=mkdtempSync(join(tmpdir(),'household-'));roots.push(r);mkdirSync(join(r,'deployments/shared'),{recursive:true});writeFileSync(join(r,'deployments/shared/config.json'),JSON.stringify({batching:{maxBatchSize:7}}));return r;}
it('saves one shared file offline and rejects a stale revision',async()=>{
 const Service=await service();const r=root();const s=new Service(r);const snap=s.snapshot();
 const result=s.saveShared('core',{'batching.maxBatchSize':8},snap.revision);
 expect(result.revision).not.toBe(snap.revision);expect(JSON.parse(readFileSync(join(r,'deployments/shared/config.json'),'utf8')).batching.maxBatchSize).toBe(8);
 expect(()=>s.saveShared('core',{'batching.maxBatchSize':9},snap.revision)).toThrow(/conflict/i);
});
it('rejects individual, unknown, and wrongly typed keys without saving',async()=>{
 const Service=await service();const r=root();const s=new Service(r);const rev=s.snapshot().revision;
 for(const patch of [{displayName:'oops'},{unknown:1},{'batching.maxBatchSize':'bad'}])expect(()=>s.saveShared('core',patch as never,rev)).toThrow();
 expect(s.snapshot().revision).toBe(rev);
});
