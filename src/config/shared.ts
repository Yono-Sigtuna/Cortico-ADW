import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { setByPath } from '../core/config-schema.ts';
import type { ConfigValues } from '../core/config-schema.ts';
import { ConfigError, type SharedConfigRef, type SharedSnapshot, type ConfigPolicy, type ConfigScope } from './types.ts';

export function objectFile(file: string): Record<string, unknown> {
 try {
  const value: unknown = JSON.parse(readFileSync(file,'utf8').replace(/^﻿/,''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  flatten(value as Record<string,unknown>);
  return value as Record<string,unknown>;
 } catch { throw new ConfigError(`Invalid configuration: ${file}`); }
}
export function flatten(value: Record<string,unknown>, prefix='', out: Record<string,unknown>={}): Record<string,unknown> {
 for (const [key,item] of Object.entries(value)) {
  if (['__proto__','prototype','constructor'].includes(key) || key.includes('.')) throw new ConfigError('Unsafe configuration key');
  const path=prefix?`${prefix}.${key}`:key;
  if (item && typeof item==='object' && !Array.isArray(item)) flatten(item as Record<string,unknown>,path,out);
  else out[path]=item;
 }
 return out;
}
export function safePath(path: string): void {
 if (!path || path.split('.').some(k=>!k || ['__proto__','prototype','constructor'].includes(k))) throw new ConfigError('Unsafe configuration path');
}
export function readPolicy(ref: SharedConfigRef, dir: string): ConfigPolicy {
 const raw=objectFile(resolve(dir,ref.policyFile));
 if (raw.version!==1 || !Array.isArray(raw.individualPrefixes) || !Array.isArray(raw.individualPaths)
  || [...raw.individualPrefixes,...raw.individualPaths].some(p=>typeof p!=='string')) throw new ConfigError('Invalid configuration policy');
 return raw as unknown as ConfigPolicy;
}
export function configScope(path: string, policy: ConfigPolicy): ConfigScope {
 safePath(path);
 return policy.individualPaths.includes(path) || policy.individualPrefixes.some(p=>path===p||path.startsWith(p+'.')) ? 'individual':'shared';
}
export function parseSharedRef(raw: unknown): SharedConfigRef | undefined {
 if (raw===undefined) return undefined;
 const r=raw as Partial<SharedConfigRef>;
 if (!r || typeof r.file!=='string'||typeof r.policyFile!=='string'||typeof r.managerUrl!=='string') throw new ConfigError('Invalid sharedConfig reference');
 const url=new URL(r.managerUrl);
 if (url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname!=='/'||url.search||url.hash) throw new ConfigError('Manager must be a loopback HTTP origin');
 return r as SharedConfigRef;
}
export function assertMigrationReady(file: string): void {
 if (existsSync(resolve(dirname(file),'.migration-in-progress'))) throw new ConfigError('Migration incomplete; recover before starting',409);
}
export function readSharedConfig(ref: SharedConfigRef, dir: string): SharedSnapshot {
 const file=resolve(dir,ref.file); assertMigrationReady(file);
 const bytes=readFileSync(file); const values=objectFile(file); delete values.providers;
 return {revision:createHash('sha256').update(bytes).digest('hex'),values};
}
export function atomicWrite(file: string, bytes: string|Buffer): void {
 mkdirSync(dirname(file),{recursive:true});const temp=`${file}.${randomUUID()}.tmp`;
 try { writeFileSync(temp,bytes,{mode:0o600});renameSync(temp,file); }
 finally { if(existsSync(temp)) unlinkSync(temp); }
}
export function withConfigLock<T>(file:string, action:()=>T):T {
 const lock=file+'.write-lock';let acquired=false;
 try { writeFileSync(lock,JSON.stringify({pid:process.pid,nonce:randomUUID()}),{flag:'wx',mode:0o600}); acquired=true;return action(); }
 catch(e) { if(!acquired) throw new ConfigError('Configuration is locked; recover the lock after confirming its writer has stopped',409);throw e; }
 finally { if(acquired) unlinkSync(lock); }
}
export function saveSharedConfig(file: string, expectedRevision: string, values: ConfigValues): SharedSnapshot {
 assertMigrationReady(file);
 return withConfigLock(file,()=>{
  const ref={file,managerUrl:'http://127.0.0.1',policyFile:''};
  const current=readSharedConfig(ref,dirname(file));
  if(current.revision!==expectedRevision) throw new ConfigError('Configuration revision conflict',409);
  for(const [path,value] of Object.entries(values)){safePath(path);if(path==='providers'||path.startsWith('providers.'))throw new ConfigError('Providers are managed separately');setByPath(current.values,path,value);}
  atomicWrite(file,JSON.stringify(current.values,null,2)+'\n');return readSharedConfig(ref,dirname(file));
 });
}
