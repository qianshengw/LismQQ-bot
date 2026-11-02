#!/usr/bin/env node
// 一次性存量清理：把 state/sessions/*.json 里遗留的内联 base64 图片块替换为占位文本。
// 用法：node scripts/clean-legacy-images.mjs [--dry-run]
// 幂等：无图片块的文件直接跳过；写回前自动备份 .bak。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS_DIR = path.join(ROOT, 'state', 'sessions');
const PLACEHOLDER = { type: 'text', text: '（历史图片已清理）' };
const dryRun = process.argv.includes('--dry-run');

if (!fs.existsSync(SESSIONS_DIR)) {
  console.log('无 sessions 目录，无事可做');
  process.exit(0);
}

let totalFiles = 0, totalBlocks = 0, totalBytesFreed = 0;
for (const name of fs.readdirSync(SESSIONS_DIR)) {
  if (!name.endsWith('.json')) continue;
  const filePath = path.join(SESSIONS_DIR, name);
  let session;
  try { session = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { console.warn(`跳过（解析失败）: ${name}`); continue; }
  if (!Array.isArray(session?.messages)) continue;

  let blocks = 0, bytes = 0;
  for (const m of session.messages) {
    if (!Array.isArray(m?.content)) continue;
    for (let i = 0; i < m.content.length; i++) {
      const b = m.content[i];
      if (b?.type === 'image' && typeof b.data === 'string' && b.data.length > 64 * 1024) {
        bytes += b.data.length;
        m.content[i] = { ...PLACEHOLDER };
        blocks++;
      }
    }
  }
  if (blocks === 0) continue;
  totalFiles++; totalBlocks += blocks; totalBytesFreed += bytes;
  const before = fs.statSync(filePath).size;
  if (dryRun) {
    console.log(`[dry-run] ${name}: ${blocks} 个图片块, 可释放 ${Math.round(bytes / 1024)}KB`);
  } else {
    fs.copyFileSync(filePath, `${filePath}.bak`);
    fs.writeFileSync(filePath, JSON.stringify(session), 'utf8');
    const after = fs.statSync(filePath).size;
    console.log(`已清理 ${name}: ${blocks} 块, ${Math.round(before / 1024)}KB -> ${Math.round(after / 1024)}KB（备份 .bak）`);
  }
}
console.log(dryRun
  ? `共 ${totalFiles} 个文件 ${totalBlocks} 块，可释放约 ${Math.round(totalBytesFreed / 1024)}KB`
  : `完成：${totalFiles} 个文件，${totalBlocks} 块，释放约 ${Math.round(totalBytesFreed / 1024)}KB`);
