// Independent audit probes. PASS means the named defect is reproduced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
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
async function defect(name,fn){await fn();count++;console.log('CONFIRMED '+name);}
try {
 await defect('R1 shown cursor makes empty-response retry receive zero messages',async()=>{
  const b=fixture(),prompts=[];
  b.sessionManager={get:async()=>({listeners:{},prompt:async p=>{prompts.push(p);return {text:''};}}),save(){}};
  b.socialV2.pushIncoming('g200',{text:'unique-request-715',atMe:true,sender:'user'});
  await b._runWakeTurn('g200','atMention');await b._runWakeTurn('g200','atMention');
  assert.equal(b.socialV2.peekUnread('g200').length,1);
  assert.ok(prompts[0].includes('unique-request-715'));assert.ok(!prompts[1].includes('unique-request-715'));
 });
 await defect('R2 OneBot seconds interpreted as milliseconds: fresh ordinary message archived',async()=>{
  const b=fixture();
  await b.handleIncoming({groupId:'200',userId:'100',text:'new message',images:[],raw:{time:Math.floor(Date.now()/1000),message:[]}});
  assert.equal(b.socialV2.peekUnread('g200').length,0);
  assert.equal(b.socialV2.get('g200').archivedCount,1);
 });
 await defect('R3 pending send acknowledged as success before eventual delivery failure',async()=>{
  const b=fixture();let rejectSend;
  b.bot.sendGroupMessage=()=>new Promise((_,reject)=>{rejectSend=reject;});
  const agent={listeners:{},prompt:async()=>{agent.listeners.onAssistantMessage({text:'hello',toolNames:[]});return {text:'hello'};}};
  b.sessionManager={get:async()=>agent,save(){}};
  b.socialV2.pushIncoming('g200',{text:'answer me',atMe:true,sender:'user'});
  await b._runWakeTurn('g200','atMention');
  assert.equal(b.socialV2.peekUnread('g200').length,0);
  rejectSend(new Error('simulated QQ send failure'));await new Promise(r=>setImmediate(r));
  assert.equal(b._hasRealSend('g200'),false);assert.equal(b.socialV2.peekUnread('g200').length,0);
 });
 await defect('R4 first textual response suppresses later textual response in same conversation turn',async()=>{
  const b=fixture(),sent=[];b.bot.sendGroupMessage=async(id,text)=>{sent.push(text);};
  await b._maybeSendImmediateAnswer('g200',{text:'first answer'});
  await b._maybeSendImmediateAnswer('g200',{text:'second answer to follow-up'});
  assert.deepEqual(sent,['first answer']);
 });
 await defect('R5 responding newest explicit request clears older unhandled pending request',async()=>{
  const b=fixture(),s=b.socialV2;
  s.pushIncoming('g200',{text:'old explicit',atMe:true});s.pushIncoming('g200',{text:'new explicit',atMe:true});
  s.trackExplicitPending('g200',s.peekUnread('g200'));
  s.markReadSeqs('g200',[2]);s.markHandled('g200',2);
  assert.equal(s.peekUnread('g200')[0].seq,1);assert.equal(s.get('g200').pendingExplicit.length,0);
 });
 await defect('R6 configured batch window ignored for newly arriving session',async()=>{
  const b=fixture();await b.handleIncoming({groupId:'200',userId:'100',text:'random ordinary',images:[],raw:{message:[]}});
  assert.equal(b.socialV2.get('g200').wakeConfig.batchWindowMs,3000);
  assert.equal(b.config.socialV2.batchWindowMs,12345);
 });
 await defect('R7 failed save still changes live wake config despite HTTP 500',async()=>{
  const b=fixture();b.socialV2.get('g200');await b._startInternalHttp();
  try {
   b.socialV2.save=()=>false;
   const r=await fetch(`http://127.0.0.1:${b.internalPort}/api/socialv2/config`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionKey:'g200',wakeConfig:{mode:'active'}})});
   assert.equal(r.status,500);assert.equal(b.socialV2.get('g200').wakeConfig.mode,'active');
  } finally {await new Promise(r=>b.internalServer.close(r));}
 });
 await defect('R8 production no-quote path disables continuation detection',async()=>{
  const b=fixture();let reason;
  b.wakeScheduler.onIncomingMessage=(key,m)=>{reason=m.questionToMe;return {hit:false};};
  assert.equal(b._isQuestionToMe({text:'然后呢',raw:{}}),true);
  await b.handleIncoming({groupId:'200',userId:'100',text:'然后呢',images:[],raw:{message:[]}});
  assert.equal(reason,false);
 });
 await defect('R9 sleep minimum above four hours overrides declared hard maximum',async()=>{
  const b=fixture();b.config.socialV2.sleepMinMs=5*3600000;b.config.socialV2.sleepMaxMs=6*3600000;
  const result=b._clampSleepUntil(Date.now()+10*3600000);
  assert.ok(result.until-Date.now()>4.9*3600000);
 });
 console.log(`${count} defect groups confirmed`);
} finally {for(const root of roots) fs.rmSync(root,{recursive:true,force:true});}
