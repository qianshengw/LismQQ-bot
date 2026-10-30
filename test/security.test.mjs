// P0 安全模块单测：脱敏双闸门 / SSRF 判定 / 单实例锁。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SENSITIVE_RE, createKnownTokens, redactByPattern, redactAll, looksSensitive } from '../src/sensitive.js';
import { isPrivateIp, isAllowedHost } from '../src/safe-fetch.js';
import { acquireInstanceLock, _resetInstanceLockForTest } from '../src/bridge.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(
        () => {
          passed++;
          console.log(`  ✓ ${name}`);
        },
        (error) => {
          failed++;
          console.error(`  ✗ ${name}`);
          console.error(`    ${error?.message ?? error}`);
        },
      );
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
  }
  return Promise.resolve();
}

console.log('security.test.mjs');

// ── SENSITIVE_RE ─────────────────────────────────────────────────────────────

await test('Windows 路径命中', () => {
  assert.ok(SENSITIVE_RE.test('配置在 C:\\Users\\jt\\secret.txt 里'));
});

await test('Unix 路径命中', () => {
  assert.ok(SENSITIVE_RE.test('去 /home/jt/.ssh 找'));
});

await test('凭据赋值命中', () => {
  assert.ok(SENSITIVE_RE.test('api_key=sk-1234567890'));
  assert.ok(SENSITIVE_RE.test('密码 是 abc123'));
});

await test('普通聊天不误伤', () => {
  assert.ok(!SENSITIVE_RE.test('今天天气不错，我们去吃饭吧'));
  assert.ok(!SENSITIVE_RE.test('价格为 123 元'));
});

// ── KNOWN_AGENT_TOKENS ──────────────────────────────────────────────────────

await test('精确名单：裸 32-hex 令牌只有名单能拦', () => {
  const token = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
  assert.ok(!SENSITIVE_RE.test(`令牌 ${token}`), '启发式不应误报 32-hex');
  const kt = createKnownTokens();
  kt.add(token);
  assert.ok(kt.includesAny(`令牌 ${token}`));
  assert.equal(kt.redact(`令牌 ${token}`), '令牌 [已脱敏]');
});

await test('精确名单：过短令牌忽略 / delete 生效', () => {
  const kt = createKnownTokens();
  kt.add('abc'); // 太短
  assert.equal(kt.size(), 0);
  kt.add('a1b2c3d4e5f6a7b8');
  assert.equal(kt.size(), 1);
  kt.delete('a1b2c3d4e5f6a7b8');
  assert.equal(kt.size(), 0);
});

// ── redactAll / looksSensitive ──────────────────────────────────────────────

await test('redactAll 双闸门合并', () => {
  const kt = createKnownTokens();
  kt.add('sk-secret-12345678');
  const out = redactAll('key 在 C:\\Users\\x\\a.txt，密钥 sk-secret-12345678', kt);
  assert.ok(!out.includes('sk-secret-12345678'));
  assert.ok(!out.includes('C:\\Users'));
});

await test('looksSensitive 判定', () => {
  const kt = createKnownTokens();
  assert.equal(looksSensitive('普通消息', kt), false);
  assert.equal(looksSensitive('password=abc123', kt), true);
});

// ── isPrivateIp ─────────────────────────────────────────────────────────────

await test('IPv4 内网判定', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
    assert.ok(isPrivateIp(ip), `${ip} 应判内网`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1']) {
    assert.ok(!isPrivateIp(ip), `${ip} 应判公网`);
  }
});

await test('IPv6 内网判定（含 IPv4-mapped / NAT64 内嵌）', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:192.168.1.1', '::ffff:127.0.0.1', '64:ff9b::c0a8:101', '2001:db8::1']) {
    assert.ok(isPrivateIp(ip), `${ip} 应判内网`);
  }
  assert.ok(!isPrivateIp('2606:4700::1111'));
});

await test('主机名放行判定', () => {
  assert.ok(!isAllowedHost('localhost'));
  assert.ok(!isAllowedHost('a.local'));
  assert.ok(!isAllowedHost('x.internal'));
  assert.ok(!isAllowedHost('127.0.0.1'));
  assert.ok(!isAllowedHost('192.168.1.1'));
  assert.ok(isAllowedHost('api.deepseek.com'));
  assert.ok(isAllowedHost('example.com'));
  assert.ok(!isAllowedHost(''));
});

// ── 单实例锁 ────────────────────────────────────────────────────────────────

await test('锁：首取成功，二次被拒', () => {
  _resetInstanceLockForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-lock-'));
  const first = acquireInstanceLock(dir);
  assert.equal(first.ok, true);
  const second = acquireInstanceLock(dir);
  assert.equal(second.ok, false);
  assert.equal(second.pid, process.pid);
  _resetInstanceLockForTest();
});

await test('锁：死 PID 自动接管', async () => {
  _resetInstanceLockForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-lock2-'));
  // 找一个确定已死的 PID：spawn 一个立即退出的子进程
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  const stalePid = child.pid;
  // 等 Windows 回收进程句柄
  for (let i = 0; i < 50; i++) {
    let alive = true;
    try { process.kill(stalePid, 0); } catch (e) { alive = e?.code === 'EPERM'; }
    if (!alive) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  let alive = true;
  try { process.kill(stalePid, 0); } catch (e) { alive = e?.code === 'EPERM'; }
  if (alive) {
    console.log('    (跳过：子进程 PID 迟迟未回收)');
    return;
  }
  fs.writeFileSync(path.join(dir, 'bridge.lock'), `${stalePid}|${Date.now()}\n`, 'utf8');
  const r = acquireInstanceLock(dir);
  assert.equal(r.ok, true, '死 PID 的锁应被接管');
});

process.exitCode = failed > 0 ? 1 : 0;
