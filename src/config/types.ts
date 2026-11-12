export interface SharedConfigRef { file: string; managerUrl: string; policyFile: string }
export interface ConfigPolicy { version: number; individualPrefixes: string[]; individualPaths: string[] }
export interface SharedSnapshot { revision: string; values: Record<string, unknown> }
export type ConfigScope = 'shared' | 'individual';
export interface SharedLoaded { ref: SharedConfigRef; revision: string; startupRevision: string }
export interface ApplyResult {
 targetRevision: string; startupRevision: string; applied: string[]; pendingRestart: string[];
 failed: Array<{path: string; error: string}>;
}
export class ConfigError extends Error {
 constructor(message: string, public readonly status = 400) { super(message); }
}
