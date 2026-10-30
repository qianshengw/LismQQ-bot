// Fixed-behavior regressions derived from the independent audit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { evaluateWakeTrigger, WAKE_PRIORITY } from '../src/social-v2.js';
import { OneBotClient, normalizeMessageSegments } from '../src/onebot.js';
const roots=[];
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-recheck-'));roots.push(root);
 const config={qq:{wsUrl:'ws://127.0.0.1:1'},model:{provider:'deepseek',model:'deepseek-flash'},persona:{name:'bot'},memory:{enabled:false},socialV2:{enabled:true,mode:'v2',batchWindowMs:12345},socialV1:{enabled:false},tools:{enabled:false},allow:{groups:['200']},deny:{},internalHost:'127.0.0.1',internalPort:0};
 const b=new Bridge({config,rootDir:root});b.running=true;b.myQQId='999';
 b.bot={sendGroupMessage:async()=>({message_id:1})};
 b.wakeScheduler.scheduleWake=()=>{};b.wakeScheduler.scheduleProactiveCheck=()=>{};
 return b;
}
let count=0;
async function defect(name,fn){await fn();count++;console.log('PASS '+name);}
try {
 await defect('R1 empty-response retry includes the original request',async()=>{
  const b=fixture(),prompts=[];
  b.sessionManager={get:async()=>({listeners:{},prompt:async p=>{prompts.push(p);return {text:''};}}),save(){}};
  b.socialV2.pushIncoming('g200',{text:'unique-request-715',atMe:true,sender:'user'});
  await b._runWakeTurn('g200','atMention');await b._runWakeTurn('g200','atMention');
  assert.equal(b.socialV2.peekUnread('g200').length,1);
  assert.ok(prompts[0].includes('unique-request-715'));assert.ok(prompts[1].includes('unique-request-715'));
 });
 await defect('R2 fresh OneBot seconds timestamp is retained',async()=>{
  const b=fixture();
  await b.handleIncoming({groupId:'200',userId:'100',text:'new message',images:[],raw:{time:Math.floor(Date.now()/1000),message:[]}});
  assert.equal(b.socialV2.peekUnread('g200').length,1);
  assert.equal(b.socialV2.get('g200').archivedCount ?? 0,0);
 });
 await defect('R3 pending delivery cannot acknowledge a request',async()=>{
  const b=fixture();let rejectSend;
  b.bot.sendGroupMessage=()=>new Promise((_,reject)=>{rejectSend=reject;});
  b.socialV2.pushIncoming('g200',{text:'answer me',atMe:true});
  b._runtimeFor('g200').responseSeqs=[1];
  const send=b._maybeSendImmediateAnswer('g200',{text:'hello'});
  assert.equal(b._hasRealSend('g200'),false);
  assert.equal(b.socialV2.peekUnread('g200').length,1);
  rejectSend(new Error('simulated failure'));await send;
  assert.equal(b.socialV2.peekUnread('g200').length,1);
 });
 await defect('R4 each distinct completed response is delivered',async()=>{
  const b=fixture(),sent=[];b.bot.sendGroupMessage=async(id,text)=>{sent.push(text);};
  await b._maybeSendImmediateAnswer('g200',{text:'first answer'});
  await b._maybeSendImmediateAnswer('g200',{text:'second answer to follow-up'});
  assert.deepEqual(sent,['first answer','second answer to follow-up']);
 });
 await defect('R5 newer response preserves older pending request',async()=>{
  const b=fixture(),s=b.socialV2;
  s.pushIncoming('g200',{text:'old explicit',atMe:true});s.pushIncoming('g200',{text:'new explicit',atMe:true});
  s.trackExplicitPending('g200',s.peekUnread('g200'));
  s.markReadSeqs('g200',[2]);s.markHandled('g200',2);
  assert.equal(s.peekUnread('g200')[0].seq,1);assert.deepEqual(s.get('g200').pendingExplicit.map(m=>m.seq),[1]);
 });
 await defect('R6 new session inherits configured batch window',async()=>{
  const b=fixture();await b.handleIncoming({groupId:'200',userId:'100',text:'random ordinary',images:[],raw:{message:[]}});
  assert.equal(b.socialV2.get('g200').wakeConfig.batchWindowMs,12345);
  assert.equal(b.config.socialV2.batchWindowMs,12345);
 });
 await defect('R7 failed save preserves live wake config',async()=>{
  const b=fixture();b.socialV2.get('g200');await b._startInternalHttp();
  try {
   b.socialV2.save=()=>false;
   const r=await fetch(`http://127.0.0.1:${b.internalPort}/api/socialv2/config`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionKey:'g200',wakeConfig:{mode:'active'}})});
   assert.equal(r.status,500);assert.equal(b.socialV2.get('g200').wakeConfig.mode,'diving');
  } finally {await new Promise(r=>b.internalServer.close(r));}
 });
 await defect('R8 production incoming path recognizes continuation',async()=>{
  const b=fixture();let reason;
  b.wakeScheduler.onIncomingMessage=(key,m)=>{reason=m.questionToMe;return {hit:false};};
  assert.equal(b._isQuestionToMe({text:'然后呢',raw:{}}),true);
  await b.handleIncoming({groupId:'200',userId:'100',text:'然后呢',images:[],raw:{message:[]}});
  assert.equal(reason,true);
 });
 await defect('R9 sleep minimum cannot override hard maximum',async()=>{
  const b=fixture();b.config.socialV2.sleepMinMs=5*3600000;b.config.socialV2.sleepMaxMs=6*3600000;
  const result=b._clampSleepUntil(Date.now()+10*3600000);
  assert.ok(result.until-Date.now()<=4*3600000);
 });
 await defect('delivery completion gates turn completion and read acknowledgement',async()=>{
  const b=fixture();let deliver;
  b.bot.sendGroupMessage=()=>new Promise(resolve=>{deliver=resolve;});
  const agent={listeners:{},prompt:async()=>{agent.listeners.onAssistantMessage({text:'delayed answer'});return {text:'delayed answer'};}};
  b.sessionManager={get:async()=>agent,save(){}};
  b.socialV2.pushIncoming('g200',{text:'question',atMe:true});
  let done=false;const run=b._runWakeTurn('g200','atMention').then(()=>{done=true;});
  await new Promise(r=>setImmediate(r));
  assert.equal(done,false);assert.equal(b.socialV2.peekUnread('g200').length,1);
  deliver({message_id:1});await run;
  assert.equal(b.socialV2.peekUnread('g200').length,0);
 });
 await defect('two completed assistant responses survive one long observation turn',async()=>{
  const b=fixture(),sent=[];b.bot.sendGroupMessage=async(id,text)=>{sent.push(text);};
  const agent={listeners:{},prompt:async()=>{
   agent.listeners.onAssistantMessage({text:'first response'});
   await b._runtimeFor('g200').answerQueue;
   b.socialV2.pushIncoming('g200',{text:'follow-up',atMe:true});
   const more=await b._waitForMessages('g200',1,0);
   b._runtimeFor('g200').responseSeqs=more.map(m=>m.seq);
   agent.listeners.onAssistantMessage({text:'second response'});
   return {text:'second response'};
  }};
  b.sessionManager={get:async()=>agent,save(){}};
  b.socialV2.pushIncoming('g200',{text:'initial question',atMe:true});
  await b._runWakeTurn('g200','atMention');
  assert.deepEqual(sent,['first response','second response']);assert.equal(b.socialV2.peekUnread('g200').length,0);
 });
 await defect('transient model error retries once without acknowledging unread',async()=>{
  const b=fixture();let scheduled=0;
  b.wakeScheduler.scheduleWake=()=>{scheduled++;};
  b.sessionManager={get:async()=>({listeners:{},prompt:async()=>({text:'',errorMessage:'Connection error.'})}),save(){}};
  b.socialV2.pushIncoming('g200',{text:'hello',atMe:true});
  await b._runWakeTurn('g200','atMention');await b._runWakeTurn('g200','atMention');
  assert.equal(scheduled,1);assert.equal(b.socialV2.peekUnread('g200').length,1);
 });
 await defect('explicit triggers retain priority when anyMessage is enabled',async()=>{
  const cfg={triggers:{anyMessage:true,atMention:true,poke:true,question:true}};
  assert.equal(evaluateWakeTrigger(cfg,{atMe:true}).reason,'atMention');
  assert.equal(evaluateWakeTrigger(cfg,{isPoke:true}).reason,'poke');
  assert.equal(evaluateWakeTrigger(cfg,{questionToMe:true}).reason,'question');
  assert.ok(WAKE_PRIORITY.atMention>WAKE_PRIORITY.anyMessage);
 });
 await defect('consumed busy wake does not run an empty forced reply',async()=>{
  const b=fixture();let calls=0;
  b._runWakeTurn=async()=>{calls++;};
  await b._deliverWakePrompt('g200','atMention');
  await b._runtimeFor('g200').queue;assert.equal(calls,0);
  b.socialV2.pushIncoming('g200',{text:'still pending',atMe:true});
  await b._deliverWakePrompt('g200','atMention');
  await b._runtimeFor('g200').queue;assert.equal(calls,1);
  await b._deliverWakePrompt('g200','manual');
  await b._runtimeFor('g200').queue;assert.equal(calls,2);
 });
 await defect('session initialization reserves busy and releases on failure',async()=>{
  const b=fixture();let fail;
  b.sessionManager={get:()=>new Promise((_,reject)=>{fail=reject;})};
  const pending=b._runWakeTurn('g200','atMention');
  assert.equal(b.wakeScheduler._runtime('g200').busy,true);
  fail(new Error('session init failed'));
  await assert.rejects(pending,/session init failed/);
  assert.equal(b.wakeScheduler._runtime('g200').busy,false);
 });
 await defect('CQ string OneBot event preserves mentions, quotes and escaped text',async()=>{
  const b=fixture();const bot=new OneBotClient({wsUrl:'ws://127.0.0.1:1'});let message;
  bot.on('onGroupMessage',m=>{message=m;});
  bot._handleFrame({post_type:'message',message_type:'group',group_id:200,user_id:100,
   message:'[CQ:at,qq=999] hi &#91;CQ:at,qq=123&#93;'});
  assert.ok(message);assert.equal(b._isAtMe(message),true);
  await b.handleIncoming(message);
  assert.equal(b.socialV2.peekUnread('g200')[0].atMe,true);
  assert.equal(normalizeMessageSegments('[CQ:reply,id=42]')[0].data.id,'42');
  assert.equal(normalizeMessageSegments('&#91;CQ:at,qq=999&#93;')[0].type,'text');
 });
 console.log(`${count} fixed-behavior groups passed`);
} finally {for(const root of roots) fs.rmSync(root,{recursive:true,force:true});}
