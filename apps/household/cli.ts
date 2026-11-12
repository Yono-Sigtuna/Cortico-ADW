import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHouseholdServer } from './server.ts';
import { planMigration, executeMigration, recoverMigration } from './migration.ts';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);

if (args[0] === 'migrate') {
  const recover = args.find((a) => a.startsWith('--recover='));
  if (args.includes('--execute')) console.log(await executeMigration(root));
  else if (recover) await recoverMigration(root, recover.slice('--recover='.length));
  else console.log(JSON.stringify(planMigration(root), null, 2));
} else {
  const portArg = args.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.slice('--port='.length)) : 7789;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid management port');
  const server = createHouseholdServer({ rootDir: root, mode: 'live' });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') console.error(`管理端口 ${port} 已被占用，未启动。三份实例不受影响。`);
    else console.error('管理服务启动失败：', error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`三小只管理：http://127.0.0.1:${port}（原生面板，底部切换实例）`));
  const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
