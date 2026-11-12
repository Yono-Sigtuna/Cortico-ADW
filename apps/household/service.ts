import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog } from './catalog.ts';import { POLICY, sensitive } from './policy.ts';
import { configScope, readSharedConfig, saveSharedConfig, safePath } from '../../src/config/shared.ts';
import { ConfigError } from '../../src/config/types.ts';
import { coerceGroupValues, type ConfigValues, type ConfigGroup } from '../../src/core/config-schema.ts';
export function validateValues(group:ConfigGroup, values:Record<string,unknown>):ConfigValues {
 if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length)throw new ConfigError('Empty configuration patch');
 for(const [path,v] of Object.entries(values)){
  safePath(path);const p=group.schema.properties[path];if(!p)throw new ConfigError(`Unknown configuration key: ${path}`);
  if(v===null&&p.nullable)continue;
  if(p.type==='array'){if(!Array.isArray(v)||v.length!==2||v.some(n=>typeof n!=='number'||!Number.isFinite(n)))throw new ConfigError(`Invalid type: ${path}`);}
  else if(!['boolean','string','number','integer'].includes(p.type)||typeof v!==(p.type==='integer'?'number':p.type)||(p.type==='integer'&&!Number.isInteger(v)))throw new ConfigError(`Invalid type: ${path}`);
 }
 const parsed=coerceGroupValues(group,values,'zh');if('error' in parsed)throw new ConfigError(parsed.error);return parsed.values;
}
export class HouseholdService {
 readonly file:string; readonly ref:{file:string;policyFile:string;managerUrl:string};
 constructor(readonly rootDir:string){this.file=join(rootDir,'deployments/shared/config.json');this.ref={file:this.file,policyFile:join(rootDir,'deployments/shared/policy.json'),managerUrl:'http://127.0.0.1:7789'};}
 snapshot(){if(!existsSync(this.file))throw new ConfigError('尚未迁移公共配置。请先完成迁移预览，并在授权停机后执行迁移。',503);return readSharedConfig(this.ref,this.rootDir);}
 catalog(){return loadCatalog().map(g=>({...g,schema:{...g.schema,properties:Object.fromEntries(Object.entries(g.schema.properties).filter(([p])=>configScope(p,POLICY)==='shared'&&!sensitive(p)))}})).filter(g=>Object.keys(g.schema.properties).length);}
 saveShared(groupId:string,values:Record<string,unknown>,expectedRevision:string){
  const group=this.catalog().find(g=>g.id===groupId);if(!group)throw new ConfigError('Unknown shared configuration group');
  if (values?.activeProvider !== undefined && (typeof values.activeProvider !== 'string' || !/^[A-Za-z0-9_-]+$/.test(values.activeProvider) || !existsSync(join(this.rootDir,'deployments/providers',values.activeProvider,'config.json')))) throw new ConfigError('Unknown model endpoint');
  return saveSharedConfig(this.file,expectedRevision,validateValues(group,values));
 }
}
