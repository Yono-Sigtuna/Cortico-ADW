import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { loadCatalog } from './catalog.ts';
import { MEMBERS, POLICY, sensitive } from './policy.ts';
import { atomicWrite, configScope, flatten, objectFile } from '../../src/config/shared.ts';
import { setByPath } from '../../src/core/config-schema.ts';
import { instanceIsRunning } from '../../src/core/instance-lock.ts';
import { ConfigError } from '../../src/config/types.ts';
import { loadDeployment } from '../../src/deploy.ts';
import type { CoreConfig } from '../../src/core/types.ts';
export interface MigrationPreview { changes:Array<{deployment:string;path:string;action:'shared'|'individual';changed:boolean; sensitive:boolean}> }
interface RecordFile { file:string; before:string|null; after:string }
interface Journal {state:'prepared'|'committed'|'restored';files:RecordFile[]}
function outputs(root:string):{files:RecordFile[];preview:MigrationPreview}{
 const depRoot=join(root,'deployments');const configs=MEMBERS.map(m=>objectFile(join(depRoot,m.id,'config.json')));
 if(MEMBERS.some(m=>objectFile(join(depRoot,m.id,'deployment.json')).sharedConfig))throw new ConfigError('Already migrated; do not migrate twice',409);
 const common:Record<string,unknown>={};const changes:MigrationPreview['changes']=[];
 const baseline=flatten(configs[0]);
 const declared=new Set(loadCatalog().flatMap(g=>Object.keys(g.schema.properties)));
 for(const config of configs)for(const path of Object.keys(flatten(config))){
  if(configScope(path,POLICY)==='shared' && (sensitive(path)||(!(path in baseline)&&!declared.has(path)))) throw new ConfigError(`Unclassified configuration field: ${path}`);
 }
 for(const [path,value] of Object.entries(baseline)){if(path==='providers'||path.startsWith('providers.'))continue;if(configScope(path,POLICY)==='shared'){
 if(sensitive(path))throw new ConfigError(`Unclassified sensitive field: ${path}`);
 setByPath(common,path,value);
 }}
 const pending:Array<[string,unknown]>=[[join(depRoot,'shared/config.json'),common],[join(depRoot,'shared/policy.json'),POLICY]];
 for(const [i,m] of MEMBERS.entries()){
 const own:Record<string,unknown>={};for(const [path,value] of Object.entries(flatten(configs[i]))){
 if(path==='providers'||path.startsWith('providers.'))throw new ConfigError('Move embedded providers to the existing provider directory before migration');
 const scope=configScope(path,POLICY);if(scope==='individual')setByPath(own,path,value);
 changes.push({deployment:m.id,path,action:scope,changed:scope==='shared'&&JSON.stringify(value)!==JSON.stringify(baseline[path]),sensitive:sensitive(path)});
 }
 // Preserve explicit writing exceptions without inventing any living state.
 if(m.id!=='amber'){setByPath(own,'creative.enabled',false);setByPath(own,'creative.longForm',false);}
 pending.push([join(depRoot,m.id,'config.json'),own]);
 const manifest=objectFile(join(depRoot,m.id,'deployment.json'));
 pending.push([join(depRoot,m.id,'deployment.json'),{...manifest,sharedConfig:{file:'../shared/config.json',policyFile:'../shared/policy.json',managerUrl:'http://127.0.0.1:7789'}}]);
 }
 return {files:pending.map(([file,after])=>({file,before:existsSync(file)?readFileSync(file).toString('base64'):null,after:JSON.stringify(after,null,2)+'\n'})),preview:{changes}};
}
export function planMigration(root:string):MigrationPreview{return outputs(root).preview;}
function assertStopped(root:string):void{
 for(const m of MEMBERS){const dir=join(root,'deployments',m.id);const cfg=objectFile(join(dir,'config.json'));const data=(cfg.paths as {data?:string}|undefined)?.data??'data';if(instanceIsRunning(isAbsolute(data)?data:resolve(dir,data)))throw new ConfigError(`Stop ${m.id} before migration`,409);}
}
export async function executeMigration(root:string,options:{afterReplace?:(file:string,index:number)=>void}={}):Promise<{migrationId:string}>{
 assertStopped(root);const shared=join(root,'deployments/shared');mkdirSync(shared,{recursive:true});
 const marker=join(shared,'.migration-in-progress');if(existsSync(join(shared,'config.json.write-lock')))throw new ConfigError('Shared writer is active',409);
 const {files}=outputs(root);const id=randomUUID();const journalDir=join(shared,'migrations',id);mkdirSync(journalDir,{recursive:true});
 const journal:Journal={state:'prepared',files};const journalFile=join(journalDir,'journal.json');atomicWrite(journalFile,JSON.stringify(journal));
 // Stage the final layout and verify it using the production loader before installing references.
 const stage=join(journalDir,'stage');
 for(const f of files)atomicWrite(join(stage,f.file.slice(join(root,'deployments').length)),f.after);
 for(const m of MEMBERS)loadDeployment({defaults:()=>({paths:{memory:'memory',data:'data'},providers:{}} as CoreConfig)},join(stage,m.id));
 writeFileSync(marker,id,{flag:'wx',mode:0o600});
 try{
  assertStopped(root);if(existsSync(join(shared,'config.json.write-lock')))throw new ConfigError('Shared writer is active',409);
  for(const [index,f] of files.entries()){atomicWrite(f.file,f.after);options.afterReplace?.(f.file,index+1);}
  journal.state='committed';atomicWrite(journalFile,JSON.stringify(journal));rmSync(marker);
  return {migrationId:id};
 }catch(error){throw new ConfigError(`Migration interrupted (${id}); recover before starting: ${error instanceof Error?error.message:'failure'}`,409);}
}
export async function recoverMigration(root:string,id:string):Promise<void>{
 if(!/^[a-f0-9-]{36}$/.test(id))throw new ConfigError('Invalid migration id');assertStopped(root);
 const shared=join(root,'deployments/shared');const file=join(shared,'migrations',id,'journal.json');const journal=JSON.parse(readFileSync(file,'utf8')) as Journal;
 const marker=join(shared,'.migration-in-progress');if(existsSync(marker)&&readFileSync(marker,'utf8')!==id)throw new ConfigError('Another migration owns the barrier',409);
 if(journal.state==='restored'){if(existsSync(marker))rmSync(marker);return;}
 if(!existsSync(marker))writeFileSync(marker,id,{flag:'wx',mode:0o600});
 for(const f of journal.files){if(!resolve(f.file).startsWith(resolve(root,'deployments')+requireSeparator()))throw new ConfigError('Invalid recovery target');if(f.before===null)rmSync(f.file,{force:true});else atomicWrite(f.file,Buffer.from(f.before,'base64'));}
 journal.state='restored';atomicWrite(file,JSON.stringify(journal));rmSync(marker);
}
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
