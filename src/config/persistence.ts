import { join, dirname, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { updateJsonObject } from '../config-file.ts';
import type { LoadedConfig } from '../core/config.ts';
import { setByPath } from '../core/config-schema.ts';
import { configScope, readPolicy, assertMigrationReady, objectFile, parseSharedRef } from './shared.ts';
export function managedConfig(file:string):boolean {
 const manifest=join(dirname(file),'deployment.json');return existsSync(manifest)&&!!parseSharedRef(objectFile(manifest).sharedConfig);
}
export function sharedProviderReferences(providersDir:string,name:string):string[]{
 const parent=dirname(providersDir);const refs=new Set<string>();
 if(!existsSync(parent))return [];
 for(const d of readdirSync(parent,{withFileTypes:true})){
  const manifest=join(parent,d.name,'deployment.json');if(!d.isDirectory()||!existsSync(manifest))continue;
  const ref=parseSharedRef(objectFile(manifest).sharedConfig);if(!ref)continue;
  const file=resolve(parent,d.name,ref.file);if(existsSync(file)&&objectFile(file).activeProvider===name)refs.add(file);
 }
 return [...refs];
}
export function assertLocalProviderSelection(file:string):void{if(managedConfig(file))throw new ConfigError('Use shared configuration to select a provider',409);}

import { ConfigError } from './types.ts';
export function assertIndividualPatch(loaded:LoadedConfig,values:Record<string,unknown>):void{
 if(!loaded.sharedConfig)return;
 assertMigrationReady(join(loaded.rootDir,'..','shared','config.json'));
 const policy=readPolicy(loaded.sharedConfig.ref,loaded.rootDir);
 for(const path of Object.keys(values))if(configScope(path,policy)!=='individual')throw new ConfigError(`Shared setting must be changed in the manager: ${path}`,409);
}
export function persistIndividualPatch(loaded:LoadedConfig,values:Record<string,unknown>):void{
 assertIndividualPatch(loaded,values);
 updateJsonObject(join(loaded.rootDir,'config.json'),raw=>{for(const [path,v] of Object.entries(values))setByPath(raw,path,v);});
}
export async function persistConfigPatch(loaded:LoadedConfig,values:Record<string,unknown>,group:string,expectedRevision?:string):Promise<string>{
 if(!loaded.sharedConfig){persistIndividualPatch(loaded,values);return 'config.json';}
 const policy=readPolicy(loaded.sharedConfig.ref,loaded.rootDir);
 const scopes=new Set(Object.keys(values).map(p=>configScope(p,policy)));
 if(scopes.size!==1)throw new ConfigError('Save shared and individual keys separately');
 if(scopes.has('individual')){persistIndividualPatch(loaded,values);return 'config.json';}
 if(!expectedRevision)throw new ConfigError('Reload configuration before saving shared settings',409);
 const response=await fetch(`${loaded.sharedConfig.ref.managerUrl}/api/shared-config`,{method:'POST',headers:{'content-type':'application/json','x-cortico-manager-key':process.env.CORTICO_MANAGER_KEY??''},body:JSON.stringify({group,values,expectedRevision,deferApply:true}),signal:AbortSignal.timeout(8000)});
 const body=await response.json() as {error?:string;savedRevision?:string};
 if(!response.ok)throw new ConfigError(body.error??'Shared save failed',response.status);
 return `shared config saved ${body.savedRevision}; inspect per-instance restart status`;
}
