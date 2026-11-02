// P1 消息质量单测：md-to-plain / 切分代理对保护 / forward 解析。
import assert from 'node:assert/strict';
import { mdToPlain, splitForQQ, truncateText } from '../src/md-to-plain.js';
import { sanitizeForwardId, extractForwardIds, formatForwardMessages, renderForwardBlock } from '../src/forward.js';
import { isSilentMarker, stripSilentMarkers, isFarewellPhrase } from '../src/social-v1.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
  }
}

console.log('message-quality.test.mjs');

// ── mdToPlain ───────────────────────────────────────────────────────────────

test('代码块去围栏保留内容', () => {
  const out = mdToPlain('看这段：\n```js\nconsole.log(1);\n```\n完了');
  assert.ok(out.includes('console.log(1);'));
  assert.ok(!out.includes('```'));
});

test('行内代码 / 粗斜体 / 删除线', () => {
  assert.equal(mdToPlain('这是 `code`'), '这是 code');
  assert.equal(mdToPlain('**粗** 与 ~~删~~'), '粗 与 删');
});

test('链接保留文字附 URL', () => {
  assert.equal(mdToPlain('[百度](https://baidu.com)'), '百度 (https://baidu.com)');
});

test('图片保留 alt', () => {
  assert.equal(mdToPlain('![一只猫](https://x.com/cat.png)'), '一只猫');
});

test('列表符转圆点', () => {
  assert.equal(mdToPlain('- 甲\n- 乙'), '• 甲\n• 乙');
});

test('乘法式不被斜体吞掉', () => {
  assert.equal(mdToPlain('2 * 3 * 4'), '2 * 3 * 4');
});

test('标题/引用符剥离', () => {
  assert.equal(mdToPlain('## 标题\n> 引用'), '标题\n引用');
});

// ── splitForQQ ──────────────────────────────────────────────────────────────

test('空文本/纯空白返回空数组', () => {
  assert.deepEqual(splitForQQ(''), []);
  assert.deepEqual(splitForQQ('   '), []);
});

test('空行分段', () => {
  assert.deepEqual(splitForQQ('第一段\n\n第二段'), ['第一段', '第二段']);
});

test('超长按换行优先切', () => {
  const text = `${'a'.repeat(300)}\n${'b'.repeat(300)}`;
  const parts = splitForQQ(text, 450);
  // 单块 601 码元 > 450：切在换行处，前段 300、后段 300
  assert.equal(parts.length, 2);
  assert.ok(parts[0].endsWith('a'));
  assert.ok(parts[1].startsWith('b') || parts[1].startsWith('\n'));
});

test('超长硬切不切代理对', () => {
  const emoji = '😀'; // 2 码元
  const text = emoji.repeat(300); // 600 码元
  const parts = splitForQQ(text, 100);
  assert.ok(parts.length >= 2);
  // 每段都不应有孤立高代理结尾
  for (const p of parts) {
    const last = p.charCodeAt(p.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `段尾不应是孤立高代理: ${JSON.stringify(p.slice(-2))}`);
  }
});

test('超出条数上限截断提示', () => {
  const text = Array.from({ length: 30 }, (_, i) => `段${i}`).join('\n\n');
  const parts = splitForQQ(text, 100, 5);
  assert.equal(parts.length, 5);
  assert.ok(parts[4].includes('截断'));
});

// ── truncateText ────────────────────────────────────────────────────────────

test('truncateText 不切代理对', () => {
  const out = truncateText('😀'.repeat(10), 11);
  assert.ok(!/\uD800$/.test(out));
});

// ── forward ─────────────────────────────────────────────────────────────────

test('sanitizeForwardId 白名单字符', () => {
  assert.equal(sanitizeForwardId('abc-123'), 'abc-123');
  assert.equal(sanitizeForwardId('bad id!'), '');
  assert.equal(sanitizeForwardId(''), '');
  assert.equal(sanitizeForwardId('x'.repeat(300)), '');
});

test('extractForwardIds 去重', () => {
  const ids = extractForwardIds([
    { type: 'forward', data: { id: 'f1' } },
    { type: 'text', data: { text: 'hi' } },
    { type: 'forward', data: { res_id: 'f1' } },
    { type: 'forward', data: { id: 'f2' } },
  ]);
  assert.deepEqual(ids, ['f1', 'f2']);
});

test('formatForwardMessages 标准 OneBot 形状', () => {
  const out = formatForwardMessages({
    messages: [
      { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '你好' } }], time: 1 },
      { sender: { card: '乙' }, message: [{ type: 'image', data: {} }], time: 2 },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].sender, '甲');
  assert.equal(out[0].text, '你好');
  assert.equal(out[1].text, '[图片]');
});

test('formatForwardMessages CQ 字符串兜底', () => {
  const out = formatForwardMessages({ messages: [{ sender: { nickname: '丙' }, message: '[CQ:image,file=1.jpg] 看图' }] });
  assert.equal(out[0].text, '[媒体] 看图');
});

test('renderForwardBlock 空消息降级', () => {
  assert.ok(renderForwardBlock('f1', []).includes('展开失败'));
  assert.ok(renderForwardBlock('f1', [{ sender: '甲', text: '内容' }]).includes('甲'));
});

// ── [SILENT] 判定与剥除（AUDIT 第 36 条：变体不得外发）──

test('isSilentMarker：整条标记及变体命中', () => {
  assert.equal(isSilentMarker('[SILENT]'), true);
  assert.equal(isSilentMarker('[silent]'), true);
  assert.equal(isSilentMarker('  [SILENT]  '), true);
  assert.equal(isSilentMarker('[SILENT]。'), true, '尾随句号应命中');
  assert.equal(isSilentMarker('[SILENT]（潜水）'), false, '括号解释不命中（有实质内容）');
  assert.equal(isSilentMarker('[SILENT] [SILENT]'), true, '重复标记命中');
  assert.equal(isSilentMarker('别理我 [SILENT]'), false, '带正文不命中');
  assert.equal(isSilentMarker(''), false);
  assert.equal(isSilentMarker(null), false);
});

test('stripSilentMarkers：剥除散落标记，剥完为空视为沉默', () => {
  assert.equal(stripSilentMarkers('hello [SILENT] world'), 'hello  world'.trim());
  assert.equal(stripSilentMarkers('[SILENT]'), '');
  assert.equal(stripSilentMarkers('[SILENT]。'), '。', '只剥标记，残余标点保留（发送无害）');
  assert.equal(stripSilentMarkers('  [silent]  '), '');
  assert.equal(stripSilentMarkers('正常内容'), '正常内容');
});

// ── 退场话术闸（用户要求全程禁退场话）──

test('isFarewellPhrase：整句退场话术命中、沉默旁白变体命中、带实质正文不命中', () => {
  assert.equal(isFarewellPhrase('我先撤了'), true);
  assert.equal(isFarewellPhrase('撤了'), true);
  assert.equal(isFarewellPhrase('那我去忙了'), true);
  assert.equal(isFarewellPhrase('我先去吃饭啦'), true);
  assert.equal(isFarewellPhrase('告辞'), true);
  assert.equal(isFarewellPhrase('回见~'), true);
  assert.equal(isFarewellPhrase('下线了。'), true);
  assert.equal(isFarewellPhrase('我先撤了。'), true, '尾随标点命中');
  // 沉默旁白变体（本次修复目标：解释+收尾的短句也要拦）
  assert.equal(isFarewellPhrase('那我先撤了，你们聊'), true, '解释+退场变体命中');
  assert.equal(isFarewellPhrase('群里没聊关于我的，收'), true, '旁白+句尾收命中');
  assert.equal(isFarewellPhrase('收了收了'), true, '重复收尾命中');
  assert.equal(isFarewellPhrase('没啥聊的，潜水去了'), true, '旁白+潜水命中');
  assert.equal(isFarewellPhrase('先不聊了'), true, '不聊了收尾命中');
  assert.equal(isFarewellPhrase('到这了，收'), true, '到这+收命中');
  // 不误伤
  assert.equal(isFarewellPhrase('撤了？真的假的'), false, '问句不命中');
  assert.equal(isFarewellPhrase('今晚吃什么'), false);
  assert.equal(isFarewellPhrase('收到，马上去办'), false, '收到的收不拦');
  assert.equal(isFarewellPhrase('快递到了我先收了再回你'), false, '收快递的收不拦');
  assert.equal(isFarewellPhrase('先不聊了，但是晚饭后继续'), false, '带转折正文不命中');
  assert.equal(isFarewellPhrase('这个问题挺有意思，先撤了那句之外我想再聊聊'), false, '较长正文不命中');
  assert.equal(isFarewellPhrase(''), false);
  assert.equal(isFarewellPhrase(null), false);
});

process.exitCode = failed > 0 ? 1 : 0;
