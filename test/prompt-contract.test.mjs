import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, loadSystemPrompt } from '../src/bridge.js';
import { SessionManager, applyCurrentSystemMessage } from '../src/pi-host.js';
import { chatBehaviorRules, RULES_MARKER, stripLegacyWakeRules } from '../src/qq-chat-rules.js';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

test('multiple real Pi requests, persistence and persona reload carry one rules block', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-prompt-'));
  const config = { qq: {}, model: {provider:'deepseek',model:'deepseek-flash'}, persona: {systemPrompt:'PERSONA_A'}, memory:{enabled:false}, socialV1:{enabled:false}, socialV2:{enabled:true,mode:'v2'}, tools:{enabled:false} };
  const bridge = new Bridge({config,rootDir:root});
  const requests=[];
  const streamFn = (model,context,options) => {
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 120000);
    requests.push(structuredClone(context.messages));
    const stream=createAssistantMessageEventStream();
    queueMicrotask(()=>{
      const msg={role:'assistant',content:[{type:'text',text:'收到'}],api:'openai-completions',provider:'deepseek',model:model.id,stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      stream.push({type:'done',reason:'stop',message:msg});stream.end(msg);
    });return stream;
  };
  const options={sessionsDir:path.join(root,'sessions'),modelConfig:config.model,systemPrompt:loadSystemPrompt(config,root),streamFn,maxMessages:100};
  try {
    const manager=new SessionManager(options);
    for(let n=0;n<3;n++) {
      bridge.socialV2.pushIncoming('g200',{text:`MESSAGE_${n}`,atMe:true});
      const wake=bridge._buildWakePrompt('g200','atMention',bridge.socialV2.peekUnread('g200'));
      assert.ok(!wake.includes(RULES_MARKER));
      assert.ok(!wake.includes('【群聊不是客服队列】'));
      await (await manager.get('g200')).prompt(wake);
    }
    manager.save('g200');
    const restored=new SessionManager(options);
    config.persona.systemPrompt='PERSONA_B';
    await restored.get('g200');
    await restored.reconfigure({systemPrompt:loadSystemPrompt(config,root)});
    await (await restored.get('g200')).prompt('new message');
    for(const messages of requests) {
      const body=JSON.stringify(messages);
      assert.equal(body.split(RULES_MARKER).length-1,1);
      assert.equal(messages[0].role,'system');
      assert.ok(!body.includes('不会自动发出去'));
    }
    assert.ok(JSON.stringify(requests.at(-1)[0]).includes('PERSONA_B'));
    assert.ok(!JSON.stringify(requests.at(-1)[0]).includes('PERSONA_A'));
  } finally {bridge.wakeScheduler?.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('old generated rules are removed for string and block content; chat/media survive',()=>{
  const legacy='【唤醒原因】atMention\n【未读消息】KEEP_MESSAGE\n【群聊不是客服队列】OLD_RULES\n【分用途等待】OLD_WAIT\n【收尾流程】KEEP_CLOSING\n【先判断：这是不是在接你的话】OLD_GUIDE\n全程不要说旧退场话';
  const ordinary='用户讨论【群聊不是客服队列】这个标题，不能删';
  const source=[{role:'system',content:'old persona'},{role:'user',content:legacy},{role:'user',content:[{type:'text',text:legacy},{type:'image',data:'keep',mimeType:'image/png'}]},{role:'user',content:ordinary}];
  const fixed=applyCurrentSystemMessage(source,'new persona\n'+chatBehaviorRules());
  assert.ok(!fixed[1].content.includes('OLD_RULES'));
  assert.ok(!fixed[2].content[0].text.includes('OLD_GUIDE'));
  assert.ok(fixed[1].content.includes('KEEP_MESSAGE'));
  assert.equal(fixed[2].content[1].data,'keep');
  assert.equal(fixed[3].content,ordinary);
  assert.ok(source[1].content.includes('OLD_RULES'));
  assert.equal(stripLegacyWakeRules(fixed[1].content),fixed[1].content);
});


test('short chat whitespace is compact, formatted and long replies survive', async()=>{
  const { normalizeChatSpacing }=await import('../src/md-to-plain.js');
  assert.equal(normalizeChatSpacing('好\n\n那就这么办'),'好 那就这么办');
  assert.equal(normalizeChatSpacing('• 第一项\n• 第二项'),'• 第一项\n• 第二项');
  const long='这是长段落。'.repeat(30)+'\n\n第二段';
  assert.equal(normalizeChatSpacing(long),long);
  assert.equal(normalizeChatSpacing('第一行\n第二行\n第三行'),'第一行\n第二行\n第三行');
});
