import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadDeployment } from '../../src/deploy.ts';
import type { CoreConfig } from '../../src/core/types.ts';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d,{recursive:true,force:true})));
function setup(individual: object = {}) {
 const root=mkdtempSync(join(tmpdir(),'shared-config-')); dirs.push(root);
 const dep=join(root,'one'); mkdirSync(dep); mkdirSync(join(root,'shared'));
 writeFileSync(join(root,'shared','config.json'),JSON.stringify({batching:{maxBatchSize:7},providers:{rogue:{}}}));
 writeFileSync(join(root,'shared','policy.json'),JSON.stringify({version:1,individualPrefixes:['web','paths'],individualPaths:['displayName']}));
 writeFileSync(join(dep,'deployment.json'),JSON.stringify({bot:'test',sharedConfig:{file:'../shared/config.json',policyFile:'../shared/policy.json',managerUrl:'http://127.0.0.1:7789'}}));
 writeFileSync(join(dep,'config.json'),JSON.stringify(individual));
 return {root,dep};
}
const defaults=()=>({paths:{memory:'memory',data:'data'},batching:{maxBatchSize:2},providers:{}} as CoreConfig);
it('loads shared defaults and preserves individual identity',()=>{
 const {dep}=setup({displayName:'one'}); const loaded=loadDeployment({defaults},dep);
 expect(loaded.config.batching.maxBatchSize).toBe(7); expect(loaded.config.displayName).toBe('one');
 expect(loaded.config.providers).not.toHaveProperty('rogue');
 expect(loaded).toHaveProperty('sharedConfig.revision');
});
it('rejects an individual copy of a shared setting',()=>{
 const {dep}=setup({batching:{maxBatchSize:9}});
 expect(()=>loadDeployment({defaults},dep)).toThrow(/batching.maxBatchSize/);
});
it('blocks partially migrated deployments',()=>{
 const {root,dep}=setup(); writeFileSync(join(root,'shared','.migration-in-progress'),'pending');
 expect(()=>loadDeployment({defaults},dep)).toThrow(/migration/i);
});
it('leaves deployments without a shared reference unchanged',()=>{
 const {dep}=setup({batching:{maxBatchSize:9}});writeFileSync(join(dep,'deployment.json'),'{"bot":"test"}');
 expect(loadDeployment({defaults},dep).config.batching.maxBatchSize).toBe(9);
});
