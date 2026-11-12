import type { ConfigPolicy } from '../../src/config/types.ts';
export const MEMBERS = [
 {id:'amber',label:'琥珀',port:7790,color:'#ad682a'},
 {id:'bailong',label:'白龙',port:7791,color:'#567d91'},
 {id:'jingyu',label:'鲸鱼',port:7792,color:'#507f6c'},
] as const;
export type HouseholdId = typeof MEMBERS[number]['id'];
export const POLICY: ConfigPolicy = {version:1,individualPrefixes:['web','paths'],individualPaths:['displayName','worlds.qq.wsUrl','worlds.qq.token','worlds.qq.wakeNames','worlds.qq.gesture.maxPerMessage','worlds.qq.gesture.maxRecent','worlds.qq.gesture.windowSize','worlds.qq.refusalHint','creative.enabled','creative.longForm']};
export const sensitive = (path:string):boolean => /(?:token|secret|password|credential|apikey|embeddingkey|accesskey)$/.test(path.split('.').at(-1)!.replaceAll('_','').toLowerCase());
