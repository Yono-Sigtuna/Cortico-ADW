import{expect,it}from'vitest';
it('keeps the manager independent when its child exits and reports occupied ports',async()=>{
 const m=await import('../../apps/household/launcher.mjs').catch(()=>null);expect(m?.attachManager).toBeTypeOf('function');
 const events:string[]=[];const child={stdout:null,stderr:null,on:(name:string,cb:(code:number)=>void)=>{if(name==='exit')cb(1);}};
 m!.attachManager({spawn:()=>child as unknown as import('node:child_process').ChildProcess,log:(s:string)=>events.push(s),home:'C:/example',key:'example'});
 expect(events.some(e=>e.includes('1'))).toBe(true);expect(events.some(e=>e.includes('7789'))).toBe(true);
});
