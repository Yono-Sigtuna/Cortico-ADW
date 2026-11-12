import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{expect,it}from'vitest';import{WorldAssembly,type WorldDefinition}from'../../src/world.ts';import{loadDeployment}from'../../src/deploy.ts';import type{CoreConfig,World}from'../../src/core/types.ts';
it('refuses shared deactivation before unmounting the active world',async()=>{
 const root=mkdtempSync(join(tmpdir(),'world-guard-'));try{
 const dep=join(root,'one');mkdirSync(dep);mkdirSync(join(root,'shared'));writeFileSync(join(dep,'deployment.json'),JSON.stringify({bot:'test',sharedConfig:{file:'../shared/config.json',policyFile:'../shared/policy.json',managerUrl:'http://127.0.0.1:7789'}}));writeFileSync(join(root,'shared/config.json'),'{"worlds":{"probe":{"enabled":true}}}');writeFileSync(join(root,'shared/policy.json'),'{"version":1,"individualPrefixes":[],"individualPaths":[]}');
 const loaded=loadDeployment({defaults:()=>({paths:{memory:'memory',data:'data'},providers:{}}as CoreConfig)},dep);let stopped=0;
 const definition:WorldDefinition={id:'probe',label:'Probe',defaults:()=>({enabled:true}),create:()=>({id:'probe',tools:()=>[],envPromptVars:()=>({}),start:async()=>{},stop:async()=>{stopped++;}}as World)};
 const assembly=new WorldAssembly(loaded,[definition],['probe']);assembly.bind({mount:async()=>{},unmount:async()=>{stopped++;}});
 await expect(assembly.deactivate('probe')).rejects.toThrow(/Shared/);expect(stopped).toBe(0);expect(assembly.slots[0].mounted).toBe(true);expect((loaded.config as unknown as {worlds:{probe:{enabled:boolean}}}).worlds.probe.enabled).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
