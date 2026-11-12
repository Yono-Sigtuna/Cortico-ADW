import type { LoadedConfig } from '../core/config.ts';
import { flatten, readSharedConfig } from './shared.ts';
import { ConfigError, type ApplyResult } from './types.ts';
import { getByPath } from '../core/config-schema.ts';
// No runtime key has yet proved dynamic across every mounted consumer. Unknown keys require restart.
export function classifyApply(_path:string):'dynamic'|'explicit'|'restart'{return 'restart';}
export function applySavedConfig(loaded:LoadedConfig, expectedRevision:string):ApplyResult{
 const info=loaded.sharedConfig;if(!info)throw new ConfigError('Shared configuration is not enabled');
 const snapshot=readSharedConfig(info.ref,loaded.rootDir);if(snapshot.revision!==expectedRevision)throw new ConfigError('Configuration revision conflict',409);
 const pendingRestart=Object.entries(flatten(snapshot.values)).filter(([path,value])=>JSON.stringify(getByPath(loaded.config as unknown as Record<string,unknown>,path))!==JSON.stringify(value)).map(([path])=>path);
 info.revision=snapshot.revision;
 return {targetRevision:snapshot.revision,startupRevision:info.startupRevision,applied:[],pendingRestart,failed:[]};
}
