import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
/**
 * @param {{home:string,key:string,spawn:(command:string,args:string[],options:object)=>import('node:child_process').ChildProcess,log:(line:string)=>void}} options
 */
export function attachManager({ home, key, spawn, log }) {
 const child=spawn(process.execPath,[resolve(home,'node_modules/tsx/dist/cli.mjs'),resolve(home,'apps/household/cli.ts')],{cwd:home,env:{...process.env,CORTICO_MANAGER_KEY:key},stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr]){
  if(!stream)continue;
  const decoder=new StringDecoder('utf8');let rest='';
  stream.on('data',chunk=>{rest+=decoder.write(chunk);const lines=rest.split(/\r?\n/);rest=lines.pop()??'';for(const line of lines)log(`[管理] ${line}`);});
  stream.on('end',()=>{rest+=decoder.end();if(rest)log(`[管理] ${rest}`);});
 }
 child.on('error',e=>log(`[管理] 启动失败：${e.message}；三份实例不受影响。`));
 child.on('exit',code=>log(`[管理] 进程结束 code=${code}；三份实例不受影响。`));
 log('[管理] 入口 http://127.0.0.1:7789/；端口占用时管理服务会明确退出。');return child;
}
