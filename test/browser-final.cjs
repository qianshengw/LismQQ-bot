// 浏览器渲染最终验证
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SHELL = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium_headless_shell-1228', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');

(async () => {
  const { Bridge } = await import('../src/bridge.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'final-'));
  fs.mkdirSync(path.join(tmp, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'roles', 'default.md'), '测试');
  const cfg = {
    qq: { wsUrl: 'ws://127.0.0.1:1' },
    model: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', baseUrl: 'https://api.deepseek.com' },
    persona: { systemPromptFile: 'roles/default.md' },
    memory: { enabled: true, maxRecords: 50, maxResults: 3 },
    socialV2: { enabled: true, mode: 'v2', limits: {} },
    socialV1: { enabled: true, mode: 'v1', limits: {} },
    allow: { private: ['100'], groups: ['200'] },
    deny: { private: [], groups: [] },
    tools: { enabled: false },
    history: { maxMessages: 120, summarize: true },
    internalPort: 0, internalHost: '127.0.0.1',
  };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
  const b = new Bridge({ config: cfg, rootDir: tmp });
  await b._startInternalHttp();
  b.myQQId = '99999';
  b.socialV2.get('g200');
  b.socialV1.enterActive('g200');
  const url = 'http://127.0.0.1:' + b.internalPort + '/?token=' + b.internalToken;
  const dom = await new Promise((res) => {
    const c = spawn(SHELL, ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=10000', '--dump-dom', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = '';
    c.stdout.on('data', (d) => (o += d));
    c.on('exit', () => res(o));
  });

  fs.writeFileSync(path.join(tmp, 'console-dom.html'), dom);

  let failures = 0;
  const r = (l, ok, extra) => { if (!ok) failures++; console.log((ok ? 'OK  ' : 'FAIL') + ' ' + l + (extra ? ' (' + extra + ')' : '')); };
  r('body ready class（Alpine 初始化完成）', /<body[^>]*class="[^"]*\bready\b/.test(dom));
  const navCount = (dom.match(/<em[^>]*>0\d<\/em>/g) || []).length;
  r('导航 8 项渲染', navCount === 8, 'found=' + navCount);
  r('运行总览文字', dom.includes('运行总览'));
  r('二代仿真文字', dom.includes('二代仿真'));
  r('一代仿真文字', dom.includes('一代仿真'));
  r('机器人 QQ', dom.includes('99999'));

  await new Promise((res) => b.internalServer.close(res));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
