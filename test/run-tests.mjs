// 测试入口：串行跑全部测试文件（子进程隔离，任一失败即非零退出）。
// Non-zero exits, signals and timeouts always fail the suite.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tests = [
  'memory-pool.test.mjs',
  'onebot.test.mjs',
  'pi-host.test.mjs',
  'bridge.test.mjs',
  'security.test.mjs',
  'message-quality.test.mjs',
  'social-v2.test.mjs',
  'social-v1.test.mjs',
  'console-pages.test.mjs',
  'deployment.test.mjs',
  'qa-fixes.test.mjs',
  'qq-tools-server.test.mjs',
  'mcp-session-binding.test.mjs',
  'persona-hotreload.test.mjs',
  'runtime-endpoint.test.mjs',
  'compaction.test.mjs',
  'repair.test.mjs',
  'quality-fixes.test.mjs',
  'simulation-regressions.test.mjs',
  'prompt-contract.test.mjs',
];


let failed = 0;
for (const file of tests) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    timeout: 120000,
  });
  if (result.status === 0) continue;

  failed++;
  console.error(`--- ${file} 失败（exit ${result.status}）---`);
}

console.log(`\n${tests.length - failed}/${tests.length} 套测试通过`);
process.exitCode = failed > 0 ? 1 : 0;
