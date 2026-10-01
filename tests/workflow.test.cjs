const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness(file,state={}){
  state.usaOnly??='off';state.followerReview??='off';
  const elements={};
  const windowListeners={};
  let listener,installedListener;
  const element=id=>elements[id] ||= {value:'',textContent:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn},classList:{contains:()=>true}};
  const ctx=vm.createContext({console,URL,Date,Set,JSON,Math,Number,String,Promise,
    document:{getElementById:element,body:{classList:{contains:()=>true}},querySelectorAll:()=>[],querySelector:()=>null},
    location:{href:'https://x.com/i/chat/123',pathname:'/i/chat/123'},
    window:{addEventListener(name,fn){(windowListeners[name]||=[]).push(fn)}},alert(){},setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){},
    chrome:{storage:{local:{async get(keys){return {...state}},async set(p){Object.assign(state,p)},async remove(keys){(Array.isArray(keys)?keys:[keys]).forEach(k=>delete state[k])}}},
      runtime:{onMessage:{addListener(fn){listener=fn}},onInstalled:{addListener(fn){installedListener=fn}},sendMessage:async()=>({tabId:1})},
      tabs:{get:async()=>({id:1,status:'complete',url:'https://x.com/alice'}),query:async()=>[{id:1}],update:async()=>{},reload(){} }}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','progress.js'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  return {ctx,state,element,run:code=>vm.runInContext(code,ctx),message:msg=>new Promise(resolve=>listener(msg,{},resolve)),
    dispatchWindow(name,event){for(const fn of windowListeners[name]||[]) fn(event)},dispatchInstalled(details){installedListener?.(details)}};
}

test('delayed composer must become stable and gain focus',async()=>{
  const h=harness('content.js');
  h.run(`let now=0;Date=class extends Date {static now(){return now}};sleep=async ms=>{now+=ms};
    const box={isConnected:true,focus(){document.activeElement=this},contains(){return false}};
    composer=()=>now>=5000?box:null;`);
  assert.equal(await h.run('waitForComposer(10000).then(b=>b===box && document.activeElement===box && now>=6000)'),true);
});

test('composer that refuses focus is never accepted',async()=>{
  const h=harness('content.js');
  h.run(`let now=0;Date=class extends Date {static now(){return now}};sleep=async ms=>{now+=ms};
    composer=()=>box;const box={isConnected:true,focus(){},contains(){return false}};`);
  assert.equal(await h.run('waitForComposer(2000)'),null);
});

test('search input is excluded even when focused',()=>{
  const h=harness('content.js');
  assert.equal(h.run(`isDmEditor({tagName:'INPUT',type:'text',getAttribute:k=>k==='aria-label'?'Search messages':null})`),false);
});

test('draft lost during editor remount is retried on the new editor',async()=>{
  const h=harness('content.js');
  h.run(`let attempts=0;const first={isConnected:true,value:''},second={isConnected:true,value:''};
    let live=first;waitForComposer=async()=>live;composer=()=>live;
    insertIntoComposer=(b,text)=>{attempts++;b.value=text};
    sleep=async()=>{if(live===first){first.isConnected=false;live=second}};
    const sendButton={disabled:false,getAttribute:()=>null};findSendButton=()=>sendButton;`);
  assert.equal(await h.run(`fillComposer('hello').then(b=>b===second && b.value==='hello' && attempts===2)`),true);
});

test('empty composer blocks approval without clicking Send',async()=>{
  const h=harness('content.js');
  h.state.pendingDmPrepare={handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'};
  h.run(`waitForComposer=async()=>({value:''});domDebug=()=>({});robustClick=()=>{throw new Error('Must not click')}`);
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice'});
  assert.equal(result.ok,false);
  assert.match(result.error,/empty/);
});

test('one approved send clicks once and waits for editor clearance',async()=>{
  const h=harness('content.js');
  h.state.pendingDmPrepare={handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'};
  h.run(`let clicks=0;const box={value:'hello'};composer=()=>box;waitForComposer=async()=>box;
    domDebug=()=>({});const sendButton={disabled:false,getAttribute:()=>null};findSendButton=()=>sendButton;
    robustClick=()=>{clicks++;box.value=''};`);
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(result.ok,true);
  assert.equal(h.run('clicks'),1);
  assert.equal(h.state.pendingDmPrepare.stage,'sent');
  assert.equal((await h.message({type:'APPROVE_SEND',expectedHandle:'alice'})).ok,false);
  assert.equal(h.run('clicks'),1);
});

test('real button handlers save collection, await generation, prepare DM, then await approval',async()=>{
  const h=harness('popup.js');
  await new Promise(setImmediate);
  Object.assign(h.state,{runState:'running',workflowStep:'loading',workflowHandle:'alice',workflowDue:Date.now()+45000,workflowTabId:1});
  h.element('apiKey').value='test-key';
  h.run(`let calls=[],finishDraft;
    tabMessage=async type=>{
      calls.push(type);
      if(type==='COLLECT_PROFILE') return {ok:true,profile:{handle:'alice',followingStatus:'yes',dmStatus:'yes',bio:'Alice bio'}};
      if(type==='PREPARE_FROM_PROFILE'){
        if((await db()).alice.processingStatus!=='preparing_dm') throw new Error('Draft must be saved before preparation');
        await chrome.storage.local.set({pendingDmPrepare:{handle:'alice',stage:'prepared'}});
        return {ok:true,prepared:true};
      }
      return {ok:true};
    };
    runtimeMessage=async()=>{
      calls.push('GENERATE');
      if((await db()).alice.bio!=='Alice bio') throw new Error('Profile must be saved before generation');
      return await new Promise(resolve=>{finishDraft=()=>resolve({ok:true,text:'Hello Alice',structured:{}})});
    };`);
  await h.run('workflowTick()');
  assert.equal(h.state.profiles.alice.bio,'Alice bio');
  assert.equal(h.state.workflowStep,'drafting');
  const generating=h.run('workflowTick()');
  await new Promise(setImmediate);
  await h.run('workflowTick()');
  assert.equal(h.state.pendingDmPrepare,undefined);
  h.run('finishDraft()');
  await generating;
  assert.equal(h.state.profiles.alice.draft,'Hello Alice');
  await h.run('workflowTick()');
  await h.run('workflowTick()');
  assert.equal(h.state.workflowStep,'approval');
  await h.run('workflowTick()');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(calls)')),['PROFILE_READY','COLLECT_PROFILE','GENERATE','PREPARE_FROM_PROFILE']);
});

test('Start with stale current profile and draft queues full collection again',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.element('handles').value='alice\nbob';
  h.element('message').value='A stale draft';
  h.run("current={handle:'alice'}");
  await h.element('start').onclick();
  assert.equal(h.state.workflowStep,'waiting');
  assert.equal(h.state.workflowHandle,'alice');
  assert.equal(h.state.currentDraft,'');
  assert.equal(h.state.workflowCollectedHandle,null);
});

test('Mark Contacted saves contact history and queues the next record without sending',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'paused',workflowTabId:1,pendingDmPrepare:{handle:'alice',stage:'prepared'}});
  h.element('handles').value='alice\nbob';
  h.element('message').value='Hello Alice';
  h.run("current={handle:'alice'};tabMessage=async()=>{throw new Error('Mark Contacted must not send')}");
  await h.element('mark').onclick();
  assert.equal(h.state.profiles.alice.contacted,true);
  assert.equal(h.state.profiles.alice.processingStatus,'contacted');
  assert.equal(h.state.workflowHandle,'bob');
  assert.equal(h.state.workflowStep,'waiting');
  assert.equal(h.state.runState,'running');
  assert.equal(h.state.pendingDmPrepare,null);
  assert.equal(h.state.currentDraft,'');
  await h.run('workflowTick()');
  assert.equal(h.state.workflowStep,'loading');
});

test('Mark Contacted on the final record completes and clears the queue',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.element('handles').value='alice';
  h.run("current={handle:'alice'}");
  await h.element('mark').onclick();
  assert.equal(h.state.profiles.alice.contacted,true);
  assert.equal(h.state.runState,'stopped');
  assert.equal(h.state.workflowStep,null);
  assert.equal(h.state.workflowCurrent,null);
  assert.equal(h.state.workflowHandle,null);
});

test('Prepare DM cannot run without completed collect and generate checkpoints',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'running',workflowStep:'preparing',workflowCurrent:{handle:'alice'},currentDraft:'stale'});
  h.run("$('openDm').onclick=()=>{throw new Error('Must not prepare stale draft')}");
  await h.run('workflowTick()');
  assert.equal(h.state.runState,'paused');
  assert.match(h.element('status').textContent,/Collection and tailored draft generation must finish/);
});

test('paused queue never navigates',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'paused',workflowStep:'waiting',workflowDue:0});
  h.run(`chrome.tabs.update=()=>{throw new Error('Must not navigate')}`);
  await h.run('workflowTick()');
  assert.equal(h.state.workflowStep,'waiting');
});

test('manual Send & Next records the approved recipient and queues the next full sequence',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'running',workflowTabId:1,workflowStep:'approval',pendingDmPrepare:{handle:'alice',stage:'prepared'}});
  h.element('handles').value='alice\nbob';
  h.element('message').value='Hello Alice';
  h.run(`current={handle:'alice'};let sends=0;tabMessage=async type=>{
    if(type!=='APPROVE_SEND') throw new Error('Unexpected message');sends++;return {ok:true};
  }`);
  await h.element('sendNext').onclick();
  assert.equal(h.run('sends'),1);
  assert.equal(h.state.profiles.alice.contacted,true);
  assert.equal(h.state.workflowHandle,'bob');
  assert.equal(h.state.workflowStep,'waiting');
  assert.equal(h.state.workflowCollectedHandle,null);
  assert.equal(h.state.workflowDraftedHandle,null);
});

function closedInboxFixture(h){
  h.run(`let clicked=[],noticeOpen=false;
    visible=()=>true;domDebug=()=>({});
    const dismiss={innerText:'Not Now',isConnected:true,click(){clicked.push('Not Now');noticeOpen=false}};
    const useNumber={innerText:'Use X Number',click(){clicked.push('Use X Number')}};
    const dialog={innerText:'@alice has a closed inbox. If you know their X Number you can still message them.',contains:el=>el===dismiss||el===useNumber};
    dismiss.parentElement=dialog;useNumber.parentElement=dialog;
    document.querySelectorAll=()=>noticeOpen?[dismiss,useNumber]:[];
    const dm={innerText:'Message',getAttribute:()=>'',click(){clicked.push('Message');noticeOpen=true}};
    findDmButton=()=>dm;
    location.pathname='/alice';location.href='https://x.com/alice';`);
}

test('closed inbox after Message click is saved and dismissed without entering X Number flow',async()=>{
  const h=harness('content.js');closedInboxFixture(h);
  h.state.pendingDmPrepare={handle:'alice',draft:'Hello Alice',startedAt:'job1',tabId:1,stage:'open_profile'};
  h.state.profiles={alice:{handle:'alice',bio:'Keep this profile',contacted:false}};
  const result=await h.run('runPrepare('+JSON.stringify(h.state.pendingDmPrepare)+')');
  assert.equal(result.unavailable,true);
  assert.equal(h.state.pendingDmPrepare.stage,'dm_unavailable');
  assert.equal(h.state.profiles.alice.processingStatus,'dm_unavailable');
  assert.equal(h.state.profiles.alice.dmReason,'closed_inbox');
  assert.equal(h.state.profiles.alice.alternativeOutreachNeeded,true);
  assert.equal(h.state.profiles.alice.contacted,false);
  assert.equal(h.state.profiles.alice.bio,'Keep this profile');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(clicked)')),['Message','Not Now']);
});

test('closed inbox detection requires matching recipient but not the X Number action',()=>{
  const h=harness('content.js');closedInboxFixture(h);
  h.run('noticeOpen=true');
  assert.equal(h.run("closedInboxNotice('bob')"),null);
  assert.equal(h.run("closedInboxNotice('ALICE').reason"),'closed_inbox');
  h.run("useNumber.innerText='Cancel'");
  assert.equal(h.run("closedInboxNotice('alice').reason"),'closed_inbox');
});

test('full navigation resumes closed-inbox handling and preserves its terminal stage',async()=>{
  const h=harness('content.js');closedInboxFixture(h);
  h.state.pendingDmPrepare={handle:'alice',draft:'hello',startedAt:'job2',tabId:1,stage:'profile_message_clicked'};
  h.run("noticeOpen=true;location.pathname='/i/chat/123'");
  await h.run('autoPreparePendingDm()');
  assert.equal(h.state.pendingDmPrepare.stage,'dm_unavailable');
  await h.run('autoPreparePendingDm()');
  assert.equal(h.state.pendingDmPrepare.stage,'dm_unavailable');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(clicked)')),['Not Now']);
});

test('closed-inbox result automatically skips the saved profile and queues the next recipient',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'running',workflowStep:'awaiting_prepare',workflowCurrent:{handle:'alice'},
    pendingDmPrepare:{handle:'alice',stage:'dm_unavailable'},profiles:{alice:{handle:'alice',processingStatus:'dm_unavailable',alternativeOutreachNeeded:true}}});
  h.element('handles').value='alice\nbob';
  await h.run('workflowTick()');
  assert.equal(h.state.workflowHandle,'bob');
  assert.equal(h.state.workflowStep,'waiting');
  assert.equal(h.state.runState,'running');
  assert.equal(h.state.profiles.alice.alternativeOutreachNeeded,true);
  assert.equal(h.state.profiles.alice.contacted,undefined);
  assert.equal(h.state.pendingDmPrepare,null);
});

test('verified text completes preparation even when Send is not yet detected',async()=>{
  const h=harness('content.js');
  h.run(`const box={value:'hello',isConnected:true};waitForComposer=async()=>box;composer=()=>box;
    sleep=async()=>{};findSendButton=()=>null;domDebug=()=>({});`);
  const job={handle:'alice',draft:'hello',startedAt:'job3'};
  h.state.pendingDmPrepare=job;
  await h.run('markPrepared('+JSON.stringify(job)+')');
  assert.equal(h.state.pendingDmPrepare.stage,'prepared');
  assert.equal(h.state.profiles.alice.processingStatus,'prepared');
});

test('early approval waits for preparation to finish before clicking once',async()=>{
  const h=harness('content.js');
  h.state.pendingDmPrepare={handle:'alice',draft:'hello',startedAt:'job4',stage:'profile_message_clicked'};
  h.run(`preparing=true;let clicks=0,waits=0;const box={value:'hello'};
    sleep=async()=>{waits++;await chrome.storage.local.set({pendingDmPrepare:{handle:'alice',draft:'hello',startedAt:'job4',stage:'prepared',preparedUrl:location.href}})};
    waitForComposer=async()=>box;composer=()=>box;domDebug=()=>({});
    const sendButton={disabled:false,getAttribute:()=>null};findSendButton=()=>sendButton;
    robustClick=()=>{clicks++;box.value=''};`);
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(result.ok,true);
  assert.equal(h.run('waits'),1);
  assert.equal(h.run('clicks'),1);
  assert.equal(h.state.pendingDmPrepare.stage,'sent');
});

test('Send lookup supports modern DM test ids and an unlabeled composer form submit',()=>{
  const h=harness('content.js');
  h.run(`visible=()=>true;
    const arrow={innerText:'',type:'button',getAttribute:k=>k==='data-testid'?'dm-composer-send-button':null};
    const form={tagName:'FORM',querySelectorAll:()=>[arrow]};
    const box={parentElement:form};`);
  assert.equal(h.run('findSendButton(box)===arrow'),true);
  h.run("arrow.getAttribute=()=>null;arrow.type='submit'");
  assert.equal(h.run('findSendButton(box)===arrow'),true);
});

test('approval cannot follow a different job while waiting for preparation',async()=>{
  const h=harness('content.js');
  h.state.pendingDmPrepare={handle:'alice',startedAt:'one',stage:'profile_message_clicked'};
  h.run(`preparing=true;domDebug=()=>({});sleep=async()=>{await chrome.storage.local.set({pendingDmPrepare:{handle:'bob',startedAt:'two',stage:'prepared'}})};
    robustClick=()=>{throw new Error('Must not click')};`);
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/job changed/);
});


test('approval waits for a late Send button, including a replaced editor',async()=>{
  const h=harness('content.js');
  h.state.pendingDmPrepare={handle:'alice',startedAt:'late',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'};
  h.run(`let now=0,clicks=0;Date=class extends Date{static now(){return now}};sleep=async ms=>{now+=ms};
    const first={value:'hello'},second={value:'hello'};
    composer=()=>now<15000?first:second;waitForComposer=async()=>first;domDebug=()=>({});
    const button={disabled:false,getAttribute:()=>null};
    findSendButton=box=>now>=30000&&box===second?button:null;
    robustClick=()=>{clicks++;second.value=''};`);
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(result.ok,true);
  assert.equal(h.run('clicks'),1);
  assert.ok(h.run('now')>=30000);
});

test('missing Send times out without a click or contact progression',async()=>{
  const h=harness('content.js');
  h.state.pendingDmPrepare={handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'};
  h.run(`let now=0;Date=class extends Date {static now(){return now}};sleep=async ms=>{now+=ms};
    const box={value:'hello'};composer=()=>box;waitForComposer=async()=>box;domDebug=()=>({});
    findSendButton=()=>null;robustClick=()=>{throw new Error('Must not click')};`);
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/within 60 seconds/);
  assert.equal(h.state.pendingDmPrepare.stage,'prepared');
});

for(const change of ['recipient','draft','route']) test('approval stops if '+change+' changes while Send loads',async()=>{
  const h=harness('content.js');
  h.state.pendingDmPrepare={handle:'alice',startedAt:'one',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'};
  h.run(`const box={value:'hello'};composer=()=>box;waitForComposer=async()=>box;domDebug=()=>({});
    findSendButton=()=>null;robustClick=()=>{throw new Error('Must not click')};
    sleep=async()=>{${change==='recipient'?"await chrome.storage.local.set({pendingDmPrepare:{handle:'bob',stage:'prepared'}})":change==='draft'?"box.value='changed'":"location.href='https://x.com/i/chat/other'"}};`);
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/changed|differs/);
});

test('Prepare DM on a fresh profile schedules all steps without manual collection or draft',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.run("chrome.tabs.query=async()=>[{id:7,url:'https://x.com/alice',windowId:1}]");
  await h.element('openDm').onclick({type:'click'});
  assert.equal(h.state.workflowHandle,'alice');
  assert.equal(h.state.workflowTabId,7);
  assert.equal(h.state.workflowStep,'waiting');
  assert.equal(h.state.runState,'running');
  assert.equal(h.state.currentDraft,'');
  assert.equal(h.state.workflowCollectedHandle,null);
  await h.run('workflowTick()');
  assert.equal(h.state.workflowStep,'loading');
  assert.ok(h.state.workflowDue>Date.now()+110000);
});

test('repeated Prepare DM does not replace an in-flight content job',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{pendingDmPrepare:{handle:'alice',startedAt:'original',stage:'profile_message_clicked'},workflowDue:Date.now()+90000});
  await h.element('openDm').onclick({type:'click'});
  assert.equal(h.state.pendingDmPrepare.startedAt,'original');
  assert.match(h.element('status').textContent,/already running/);
});

test('profile hydration is allowed past the old 45-second loading limit',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.run(`let now=1000;Date=class extends Date {static now(){return now}};
    tabMessage=async()=>({ok:false,reason:'Waiting for profile header'});
    chrome.tabs.get=async()=>({id:1,url:'https://x.com/alice',status:'complete'});`);
  Object.assign(h.state,{runState:'running',workflowTabId:1,workflowStep:'waiting',workflowHandle:'alice',workflowDue:0});
  await h.run('workflowTick()');
  h.run('now=61000');await h.run('workflowTick()');
  assert.equal(h.state.runState,'running');
  assert.equal(h.state.workflowStep,'loading');
  assert.match(h.element('status').textContent,/Waiting for profile header/);
  h.run('now=122000');await h.run('workflowTick()');
  assert.equal(h.state.runState,'paused');
  assert.match(h.element('log').textContent,/WORKFLOW FAILED/);
});

test('profile readiness requires the right route and settled profile data',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);
  h.run(`let now=0;Date=class extends Date {static now(){return now}};
    let name='';txt=selector=>selector.includes('UserName')?name:'';
    location.pathname='/alice';document.readyState='complete';`);
  assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).ok,false);
  h.run("name='Alice';now=5000");
  assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).ok,false);
  h.run('now=6600');
  assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).ok,true);
  assert.equal((await h.message({type:'PROFILE_READY',handle:'bob'})).ok,false);
  h.run("name='Alice updated'");
  assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).ok,false);
});

test('preparation acknowledges before work completes and persists later failures',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);
  h.state.pendingDmPrepare={handle:'alice',draft:'Hello Alice',tabId:1,stage:'open_profile'};
  h.run("let failPrepare;runPrepare=async()=>new Promise((resolve,reject)=>{failPrepare=()=>reject(new Error('Message button missing'))});domDebug=()=>({url:location.href})");
  const response=await h.message({type:'PREPARE_FROM_PROFILE',handle:'alice',draft:'Hello Alice'});
  assert.equal(response.accepted,true);
  await new Promise(setImmediate);
  h.run('failPrepare()');await new Promise(setImmediate);
  assert.equal(h.state.pendingDmPrepare.stage,'failed');
  assert.match(h.state.contentDebugLog,/Message button missing/);
});

test('content diagnostics survive UI logging and include concurrent page events',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);
  h.state.debugLog='UI diagnostics';
  await h.run("Promise.all([appendPersistentLog('EVENT ONE',{}),appendPersistentLog('EVENT TWO',{})])");
  assert.equal(h.state.debugLog,'UI diagnostics');
  assert.match(h.state.contentDebugLog,/EVENT ONE/);
  assert.match(h.state.contentDebugLog,/EVENT TWO/);
});

test('stale content scripts give a refresh instruction instead of silent progress',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.run("chrome.tabs.query=async()=>[{id:1,url:'https://x.com/alice'}];chrome.tabs.sendMessage=(id,msg,cb)=>cb({ok:true,version:'1.9.5'})");
  const result=await h.run("tabMessage('PING')");
  assert.equal(result.ok,false);
  assert.match(result.error,/Refresh the X tab/);
  assert.match(h.element('log').textContent,/TAB RESULT/);
});

test('missing content receiver reports the tab and actionable error',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.run("chrome.tabs.query=async()=>[{id:19,url:'https://x.com/alice'}];chrome.runtime.lastError={message:'Could not establish connection. Receiving end does not exist.'};chrome.tabs.sendMessage=(id,msg,cb)=>cb()");
  const result=await h.run("tabMessage('PING')");
  assert.equal(result.ok,false);
  assert.match(result.error,/Refresh the X tab/);
  assert.match(h.element('log').textContent,/19/);
});

test('Prepare DM preserves reviewed edits after automatic collection and drafting',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.run("current={handle:'alice'};chrome.tabs.query=async()=>[{id:1,url:'https://x.com/i/chat/123'}]");
  h.element('message').value='My reviewed edit';
  Object.assign(h.state,{workflowCollectedHandle:'alice',workflowDraftedHandle:'alice',pendingDmPrepare:{handle:'alice',stage:'prepared'}});
  await h.element('openDm').onclick({type:'click'});
  assert.equal(h.state.workflowStep,'preparing');
  assert.equal(h.state.currentDraft,'My reviewed edit');
  assert.equal(h.state.workflowCurrent.handle,'alice');
});

test('Start resumes an active preparation without discarding its job',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'paused',workflowTabId:1,workflowStep:'awaiting_prepare',workflowDue:Date.now()+60000,pendingDmPrepare:{handle:'alice',stage:'profile_message_clicked',startedAt:'keep'}});
  await h.element('start').onclick();
  assert.equal(h.state.runState,'running');
  assert.equal(h.state.pendingDmPrepare.startedAt,'keep');
  assert.equal(h.state.workflowStep,'awaiting_prepare');
});

test('unversioned older content scripts require a refresh',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.run("chrome.tabs.query=async()=>[{id:1,url:'https://x.com/alice'}];chrome.tabs.sendMessage=(id,msg,cb)=>cb({ok:true})");
  const result=await h.run("tabMessage('PING')");
  assert.equal(result.ok,false);
  assert.match(result.error,/older build/);
});

test('missing account notice requires explicit visible notice on the target profile',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);
  h.run(`location.pathname='/alice';document.readyState='complete';
    let noticeText='This account doesn’t\\nexist',shown=true,name='';
    const notice={get innerText(){return noticeText}};
    const root={querySelectorAll:()=>[notice]};
    document.querySelector=selector=>selector.includes('primaryColumn')?root:null;
    visible=()=>shown;txt=selector=>selector.includes('UserName')?name:'';`);
  assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).accountNotFound,true);
  assert.equal((await h.message({type:'COLLECT_PROFILE',handle:'alice'})).accountNotFound,true);
  assert.equal((await h.message({type:'PROFILE_READY',handle:'bob'})).accountNotFound,undefined);
  h.run('shown=false');
  assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).accountNotFound,undefined);
  h.run("shown=true;name='Alice'");
  assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).accountNotFound,true);
  h.run("name='';noticeText='Something went wrong'");
  assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).accountNotFound,undefined);
  h.run(`noticeText="This account doesn't exist"`);
  assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).accountNotFound,true);
});

for(const last of [false,true]) test(`missing account is saved and ${last?'completes queue':'advances without collection or drafting'}`,async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'running',workflowStep:'loading',workflowHandle:'alice',workflowTabId:1,workflowDue:Date.now()+120000});
  h.element('handles').value=last?'alice':'alice\nbob';
  h.run(`tabMessage=async type=>{
    if(type!=='PROFILE_READY') throw new Error('Must not collect or prepare missing account');
    return {ok:false,accountNotFound:true,handle:'alice',reason:'This account doesn’t exist'};
  }`);
  await h.run('workflowTick()');
  assert.equal(h.state.profiles.alice.processingStatus,'account_not_found');
  assert.ok(h.state.profiles.alice.accountNotFoundAt);
  assert.equal(h.state.profiles.alice.contacted,undefined);
  assert.equal(h.state.workflowHandle,last?null:'bob');
  assert.equal(h.state.runState,last?'stopped':'running');
  assert.equal(await h.run('nextHandle()'),last?undefined:'bob');
});

test('plain div/span missing notice advances the real workflow on its first check',async()=>{
  const page=harness('content.js'),panel=harness('popup.js');
  await new Promise(setImmediate);
  page.run(`location.pathname='/ViralChillVibes';document.readyState='complete';
    let excluded=false,shown=true;
    const nodes=[{tag:'div',innerText:'This account doesn’t exist'},
      {tag:'span',innerText:'This account doesn’t exist'},
      {tag:'div',innerText:'Try searching for another.'}];
    nodes.forEach(el=>{el.closest=()=>excluded?{}:null;el.getBoundingClientRect=()=>({width:shown?300:0,height:60})});
    getComputedStyle=()=>({visibility:'visible',display:'block'});
    const root={querySelectorAll:selector=>nodes.filter(el=>selector.split(',').map(s=>s.trim()).includes(el.tag))};
    document.querySelector=selector=>selector==='[data-testid="primaryColumn"]'?root:null;`);
  Object.assign(panel.state,{runState:'running',workflowStep:'loading',workflowHandle:'ViralChillVibes',workflowTabId:1,workflowDue:Date.now()+120000});
  panel.element('handles').value='ViralChillVibes\nbob';
  panel.ctx.readPage=msg=>page.message(msg);
  panel.run(`chrome.tabs.get=async()=>({id:1,status:'complete',url:'https://x.com/ViralChillVibes'});
    tabMessage=async(type,args)=>readPage({type,...args});`);
  await panel.run('workflowTick()');
  assert.equal(panel.state.profiles.viralchillvibes.processingStatus,'account_not_found');
  assert.equal(panel.state.workflowHandle,'bob');
  assert.equal(panel.state.runState,'running');
  page.run('excluded=true');
  assert.equal((await page.message({type:'PROFILE_READY',handle:'ViralChillVibes'})).accountNotFound,undefined);
  page.run('excluded=false;shown=false');
  assert.equal((await page.message({type:'PROFILE_READY',handle:'ViralChillVibes'})).accountNotFound,undefined);
});

test('recipient closed-inbox text without dialog buttons closes the record and advances',async()=>{
  const page=harness('content.js'),panel=harness('popup.js');
  await new Promise(setImmediate);
  const job={handle:'__STNZ__',draft:'Hello',startedAt:'closed-inbox',tabId:1,stage:'profile_message_clicked'};
  page.state.pendingDmPrepare=job;
  page.run(`visible=()=>true;location.pathname='/i/chat/123';
    const notice={innerText:'@__STNZ__ has a closed inbox. If you know their X Number you can still message them.'};
    document.querySelectorAll=selector=>selector.includes('main div')?[notice]:[];`);
  assert.equal(page.run("closedInboxNotice('someone_else')"),null);
  await page.run('autoPreparePendingDm()');
  assert.equal(page.state.profiles.__stnz__.processingStatus,'dm_unavailable');
  assert.equal(page.state.pendingDmPrepare.stage,'dm_unavailable');
  Object.assign(panel.state,page.state,{runState:'running',workflowStep:'awaiting_prepare',workflowCurrent:{handle:'__STNZ__'}});
  panel.element('handles').value='__STNZ__\nbob';
  await panel.run('workflowTick()');
  assert.equal(panel.state.workflowHandle,'bob');
  assert.equal(panel.state.runState,'running');
  assert.equal(panel.state.pendingDmPrepare,null);
});

test('closed inbox discovered during approval advances without marking contacted',async()=>{
  const page=harness('content.js'),panel=harness('popup.js');
  await new Promise(setImmediate);
  closedInboxFixture(page);
  const job={handle:'alice',draft:'Hello Alice',startedAt:'approval-closed',stage:'prepared',preparedUrl:'https://x.com/alice'};
  page.state.pendingDmPrepare=job;
  page.run('noticeOpen=true');
  const result=await page.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'Hello Alice'});
  assert.equal(result.ok,true);
  assert.equal(result.unavailable,true);
  assert.equal(page.state.profiles.alice.processingStatus,'dm_unavailable');
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(clicked)')),['Not Now']);
  Object.assign(panel.state,{pendingDmPrepare:job,workflowCurrent:{handle:'alice'},runState:'running'});
  panel.run("current={handle:'alice'}");
  panel.element('message').value='Hello Alice';
  panel.element('handles').value='alice\nbob';
  panel.ctx.closedResult=result;
  panel.ctx.savedProfiles=page.state.profiles;
  panel.run('tabMessage=async()=>{await chrome.storage.local.set({profiles:savedProfiles});return closedResult}');
  await panel.element('sendNext').onclick();
  assert.equal(panel.state.workflowHandle,'bob');
  assert.equal(panel.state.profiles.alice.processingStatus,'dm_unavailable');
  assert.equal(panel.state.profiles.alice.contacted,undefined);
});

for(const stage of ['prepared','failed']) test(`late closed-inbox notice is handled from ${stage}`,async()=>{
  const h=harness('content.js');closedInboxFixture(h);
  h.state.pendingDmPrepare={handle:'alice',draft:'Hello',startedAt:'late-notice',stage,tabId:1};
  h.run('noticeOpen=true');
  await h.run('autoPreparePendingDm()');
  assert.equal(h.state.pendingDmPrepare.stage,'dm_unavailable');
  assert.equal(h.state.profiles.alice.processingStatus,'dm_unavailable');
});

function readyAutomaticPanel(h){
  Object.assign(h.state,{autoSend:true,runState:'running',workflowStep:'approval',workflowHandle:'alice',
    workflowCurrent:{handle:'alice'},currentDraft:'Hello Alice',pendingDmPrepare:{handle:'alice',stage:'prepared',draft:'Hello Alice'}});
  h.element('handles').value='alice\nbob';
}

test('automatic mode sends exactly once and advances without approval',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);readyAutomaticPanel(h);
  h.run(`let sends=0;tabMessage=async(type,payload)=>{
    if(type!=='APPROVE_SEND'||payload.automatic!==true) throw new Error('Wrong send path');
    sends++;await Promise.resolve();return {ok:true};
  }`);
  await Promise.all([h.run('workflowTick()'),h.run('workflowTick()')]);
  assert.equal(h.run('sends'),1);
  assert.equal(h.state.profiles.alice.contacted,true);
  assert.equal(h.state.workflowHandle,'bob');
});

test('disabling automatic sending leaves ready draft awaiting approval',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);readyAutomaticPanel(h);h.state.autoSend=false;
  h.run(`tabMessage=async()=>{throw new Error('Must not send')}`);
  await h.run('workflowTick()');
  assert.equal(h.state.workflowStep,'approval');
  assert.equal(h.state.profiles,undefined);
});

test('automatic loading failures retry twice then flag recipient and advance',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.element('handles').value='alice\nbob';
  h.run("tabMessage=async()=>({ok:false,error:'Profile failed to hydrate'})");
  for(let attempt=1;attempt<=3;attempt++){
    Object.assign(h.state,{autoSend:true,runState:'running',workflowStep:'loading',workflowHandle:'alice',workflowDue:0,workflowTabId:1});
    await h.run('workflowTick()');
    assert.equal(h.state.runState,'running');
    assert.equal(h.state.profiles.alice.workflowFailures,attempt);
    assert.equal(h.state.workflowStep,'waiting');
    assert.equal(h.state.workflowHandle,attempt===3?'bob':'alice');
  }
  assert.equal(h.state.profiles.alice.processingStatus,'needs_review');
  assert.match(h.state.profiles.alice.lastWorkflowError,/hydrate/);
});

test('automatic send failure is flagged and skipped without resending',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);readyAutomaticPanel(h);
  h.run("let sends=0;tabMessage=async()=>{sends++;return {ok:false,error:'Response channel closed'}}");
  await h.run('workflowTick()');
  assert.equal(h.run('sends'),1);
  assert.equal(h.state.profiles.alice.processingStatus,'needs_review');
  assert.equal(h.state.profiles.alice.contacted,undefined);
  assert.equal(h.state.workflowHandle,'bob');
  assert.equal(h.state.runState,'running');
});

for(const runState of ['paused','stopped']) test(`${runState} during send is preserved after success`,async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);readyAutomaticPanel(h);
  h.run(`tabMessage=async()=>{await chrome.storage.local.set({runState:'${runState}'});return {ok:true}}`);
  await h.run('workflowTick()');
  assert.equal(h.state.profiles.alice.contacted,true);
  assert.equal(h.state.runState,runState);
  assert.equal(h.state.workflowStep,null);
});

test('reopening panel reconciles saved sent result without another send',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);readyAutomaticPanel(h);
  h.state.pendingDmPrepare.stage='sent';h.state.workflowStep='sending';
  h.run("tabMessage=async()=>{throw new Error('Must not resend')}");
  await h.run('workflowTick()');
  assert.equal(h.state.profiles.alice.contacted,true);
  assert.equal(h.state.workflowHandle,'bob');
});

test('lost response after saved sent result still records successful contact',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);readyAutomaticPanel(h);
  h.run(`tabMessage=async()=>{
    const p=(await chrome.storage.local.get('pendingDmPrepare')).pendingDmPrepare;
    await chrome.storage.local.set({pendingDmPrepare:{...p,stage:'sent'}});
    return {ok:false,error:'Channel closed'};
  }`);
  await h.run('workflowTick()');
  assert.equal(h.state.profiles.alice.contacted,true);
  assert.equal(h.state.workflowHandle,'bob');
});

test('interrupted send expires into review and advances without a second click',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);readyAutomaticPanel(h);
  h.state.workflowStep='sending';h.state.pendingDmPrepare.stage='sending';h.state.workflowDue=0;
  h.run("tabMessage=async()=>{throw new Error('Must not resend')}");
  await h.run('workflowTick()');
  assert.equal(h.state.profiles.alice.processingStatus,'needs_review');
  assert.equal(h.state.workflowHandle,'bob');
});

test('missing preparation deadline enters recovery instead of waiting forever',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);readyAutomaticPanel(h);
  h.state.workflowStep='awaiting_prepare';h.state.pendingDmPrepare=null;
  await h.run('workflowTick()');
  assert.equal(h.state.workflowStep,'waiting');
  assert.equal(h.state.profiles.alice.workflowFailures,1);
});

test('content script checks automatic toggle and run state before clicking',async()=>{
  for(const settings of [{autoSend:false,runState:'running'},{autoSend:true,runState:'paused'},{autoSend:true,runState:'stopped'}]){
    const h=harness('content.js');Object.assign(h.state,settings);
    h.state.pendingDmPrepare={handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'};
    h.run("domDebug=()=>({});robustClick=()=>{throw new Error('Must not click')}");
    const r=await h.message({type:'APPROVE_SEND',automatic:true,expectedHandle:'alice',expectedDraft:'hello'});
    assert.equal(r.ok,false);assert.match(r.error,/cancelled/);
    assert.equal(h.state.pendingDmPrepare.stage,'prepared');
  }
});

test('pause while send control is loading prevents automatic click',async()=>{
  const h=harness('content.js');Object.assign(h.state,{autoSend:true,runState:'running'});
  h.state.pendingDmPrepare={handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'};
  h.run(`let clicks=0;const box={value:'hello'};waitForComposer=async()=>box;domDebug=()=>({});
    waitForApprovedSend=async()=>{await chrome.storage.local.set({runState:'paused'});return {box,button:{}}};robustClick=()=>clicks++;`);
  const r=await h.message({type:'APPROVE_SEND',automatic:true,expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(r.ok,false);assert.equal(h.run('clicks'),0);
});

test('late failed preparation cannot overwrite a replacement job',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);
  h.state.pendingDmPrepare={handle:'alice',startedAt:'old',draft:'Hello',stage:'open_profile'};
  h.run(`let rejectOld;runPrepare=()=>new Promise((resolve,reject)=>rejectOld=reject);domDebug=()=>({});`);
  await h.message({type:'PREPARE_FROM_PROFILE',handle:'alice',draft:'Hello'});
  await new Promise(setImmediate);
  h.state.pendingDmPrepare={handle:'bob',startedAt:'new',stage:'prepared'};
  h.run("rejectOld(new Error('Old failure'))");await new Promise(setImmediate);
  assert.equal(h.state.pendingDmPrepare.handle,'bob');
  assert.equal(h.state.pendingDmPrepare.stage,'prepared');
});

test('missing workflow tab does not redirect sending to the active tab',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'running',workflowTabId:99});
  h.run("chrome.tabs.get=async()=>{throw new Error('Tab closed')};chrome.tabs.query=async()=>{throw new Error('Must not fall back')}");
  await assert.rejects(h.run('active()'),/Tab closed/);
});

test('automatic sending defaults off, persists immediately, and restores',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  assert.equal(h.element('autoSend').checked,false);
  h.element('autoSend').checked=true;
  await h.element('autoSend').listeners.change();
  assert.equal(h.state.autoSend,true);
  h.element('autoSend').checked=false;
  await h.run('restore()');
  assert.equal(h.element('autoSend').checked,true);
});

test('automatic queue completes collection through sending and stops at the end',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.element('handles').value='alice';h.element('apiKey').value='test-key';
  Object.assign(h.state,{autoSend:true,runState:'running',workflowStep:'loading',workflowHandle:'alice',workflowTabId:1,workflowDue:Date.now()+120000});
  h.run(`let calls=[];
    runtimeMessage=async()=>{calls.push('DRAFT');return {ok:true,text:'Hello Alice'}};
    tabMessage=async type=>{
      calls.push(type);
      if(type==='COLLECT_PROFILE') return {ok:true,profile:{handle:'alice',followingStatus:'yes',dmStatus:'yes'}};
      if(type==='PREPARE_FROM_PROFILE'){
        const p=(await chrome.storage.local.get('pendingDmPrepare')).pendingDmPrepare;
        await chrome.storage.local.set({pendingDmPrepare:{...p,stage:'prepared'}});
      }
      return {ok:true};
    };`);
  for(let i=0;i<5;i++) await h.run('workflowTick()');
  assert.equal(h.state.runState,'stopped');
  assert.equal(h.state.workflowStep,null);
  assert.equal(h.state.profiles.alice.contacted,true);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(calls)')),['PROFILE_READY','COLLECT_PROFILE','DRAFT','PREPARE_FROM_PROFILE','APPROVE_SEND']);
});

test('processed recipients survive a fresh panel and stale workflow cursor',async()=>{
  const first=harness('popup.js');await new Promise(setImmediate);
  first.element('handles').value='alice\nbob';
  first.run("current={handle:'alice'}");
  await first.element('mark').onclick();
  assert.equal(first.state['processedProfile:alice'].processingStatus,'contacted');
  const disk=JSON.parse(JSON.stringify(first.state));
  Object.assign(disk,{runState:'paused',workflowStep:'loading',workflowHandle:'alice',workflowCurrent:{handle:'alice'}});
  const reopened=harness('popup.js',disk);await new Promise(setImmediate);
  assert.match(reopened.element('progress').textContent,/1 of 2 processed/);
  await reopened.element('start').onclick();
  assert.equal(reopened.state.workflowHandle,'bob');
  assert.equal(reopened.state.workflowStep,'waiting');
  assert.equal(await reopened.run('nextHandle()'),'bob');
});

test('content saves contact history even with no panel to receive the send result',async()=>{
  const page=harness('content.js');await new Promise(setImmediate);
  Object.assign(page.state,{handles:'alice\nbob',runState:'stopped',pendingDmPrepare:{handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'}});
  page.run(`const box={value:'hello'};composer=()=>box;waitForComposer=async()=>box;
    domDebug=()=>({});const button={disabled:false,getAttribute:()=>null};findSendButton=()=>button;
    robustClick=()=>{box.value=''};`);
  assert.equal((await page.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'})).ok,true);
  assert.equal(page.state['processedProfile:alice'].contacted,true);
  const reopened=harness('popup.js',JSON.parse(JSON.stringify(page.state)));await new Promise(setImmediate);
  assert.equal(await reopened.run('nextHandle()'),'bob');
  assert.equal((await reopened.run('db()')).alice.draft,'hello');
});

test('stale profile-map writes cannot erase completed recipient history',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.element('handles').value='alice\nbob\ncarol';
  await h.run("Promise.all([saveProfile({handle:'alice'},{processingStatus:'contacted',contacted:true}),saveProfile({handle:'bob'},{processingStatus:'dm_unavailable'})])");
  h.state.profiles={alice:{handle:'alice',processingStatus:'drafted'}};
  const records=await h.run('db()');
  assert.equal(records.alice.processingStatus,'contacted');
  assert.equal(records.bob.processingStatus,'dm_unavailable');
  assert.equal(await h.run('nextHandle()'),'carol');
});

test('legacy contacted flags and mixed-case keys are restored and excluded',async()=>{
  const h=harness('popup.js',{handles:'alice\nbob\ncarol',profiles:{
    Alice:{handle:'@Alice',contacted:true,processingStatus:'drafted'},
    BOB:{contactedAt:'2026-09-30T10:00:00Z'},
  }});await new Promise(setImmediate);
  assert.equal(await h.run('nextHandle()'),'carol');
  assert.equal(h.state['processedProfile:alice'].processingStatus,'contacted');
  assert.equal(h.state['processedProfile:bob'].processingStatus,'contacted');
});

test('legacy sent job recovers contact even when current profile was lost',async()=>{
  const h=harness('popup.js',{handles:'alice\nbob',pendingDmPrepare:{stage:'sent',handle:'alice',draft:'Delivered'},workflowCurrent:null});
  await new Promise(setImmediate);
  assert.equal(await h.run('nextHandle()'),'bob');
  assert.equal(h.state['processedProfile:alice'].draft,'Delivered');
});

test('Start restores saved draft checkpoint instead of overwriting it with stale UI',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{handles:'alice',runState:'paused',workflowTabId:1,workflowStep:'preparing',workflowHandle:'alice',
    workflowCurrent:{handle:'alice'},currentDraft:'Saved tailored draft',workflowCollectedHandle:'alice',workflowDraftedHandle:'alice'});
  h.element('handles').value='alice';h.element('message').value='Stale view';h.run('current=null');
  await h.element('start').onclick();
  assert.equal(h.state.currentDraft,'Saved tailored draft');
  assert.equal(h.state.workflowStep,'preparing');
  assert.equal(h.element('message').value,'Saved tailored draft');
});

test('reopening a completed queue does not restart from its first profile',async()=>{
  const h=harness('popup.js',{handles:'alice\nbob',runState:'stopped',profiles:{
    alice:{handle:'alice',processingStatus:'contacted'},bob:{handle:'bob',processingStatus:'account_not_found'}
  }});await new Promise(setImmediate);
  await h.element('start').onclick();
  assert.equal(h.state.runState,'stopped');
  assert.equal(h.state.workflowHandle,null);
  assert.match(h.element('progress').textContent,/2 of 2 processed/);
});

test('explicit Reset progress clears durable records and checkpoints',async()=>{
  const h=harness('popup.js',{handles:'alice',profiles:{alice:{handle:'alice',contacted:true}},workflowCollectedHandle:'alice',workflowDraftedHandle:'alice'});
  await new Promise(setImmediate);h.run('confirm=()=>true');
  await h.element('reset').onclick();
  assert.equal(h.state['processedProfile:alice'],undefined);
  assert.equal(h.state.workflowCollectedHandle,undefined);
  assert.equal(h.state.workflowDraftedHandle,undefined);
  assert.equal(h.state.handles,'alice');
  assert.equal(await h.run('nextHandle()'),'alice');
});

test('running queue with stale completed cursor advances immediately after reload',async()=>{
  const h=harness('popup.js',{handles:'alice\nbob',runState:'running',workflowHandle:'alice',workflowStep:'approval',
    workflowCurrent:{handle:'alice'},currentDraft:'old',autoSend:true,
    'processedProfile:alice':{handle:'alice',processingStatus:'contacted',contacted:true}});
  await new Promise(setImmediate);
  assert.equal(h.state.workflowHandle,'bob');
  assert.equal(h.state.workflowStep,'waiting');
});

test('content refuses a stale prepared job for an already saved contact',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);
  Object.assign(h.state,{'processedProfile:alice':{handle:'alice',processingStatus:'contacted'},
    pendingDmPrepare:{handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'}});
  h.run("domDebug=()=>({});robustClick=()=>{throw new Error('Must not resend')}");
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/already saved as contacted/);
});

test('saving immediately after opening waits for stored settings to load',async()=>{
  const h=harness('popup.js',{handles:'alice\nbob',apiKey:'existing-key',runState:'paused'});
  await h.run('store()');
  assert.equal(h.state.handles,'alice\nbob');
  assert.equal(h.state.apiKey,'existing-key');
});

test('stale popup cannot overwrite a newer queue from another panel',async()=>{
  const disk={handles:'alice',runState:'paused'};
  const popup=harness('popup.js',disk),panel=harness('popup.js',disk);
  await new Promise(setImmediate);
  panel.element('handles').value='alice\nbob';
  await panel.element('handles').listeners.input();
  await panel.run("saveProfile({handle:'alice'},{processingStatus:'contacted',contacted:true})");
  assert.equal(popup.element('handles').value,'alice');
  await popup.run('store()');
  assert.equal(disk.handles,'alice\nbob');
  assert.equal(await popup.run('nextHandle()'),'bob');
  await popup.element('start').onclick();
  assert.equal(disk.workflowHandle,'bob');
});

test('editing one setting in a stale view preserves other saved settings',async()=>{
  const h=harness('popup.js',{handles:'alice',marketCap:'old',projectFacts:'original',runState:'paused'});
  await new Promise(setImmediate);
  h.state.handles='alice\nbob';h.state.projectFacts='updated elsewhere';
  h.element('marketCap').value='new';
  await h.run('store()');
  assert.equal(h.state.marketCap,'new');
  assert.equal(h.state.projectFacts,'updated elsewhere');
  assert.equal(h.state.handles,'alice\nbob');
});

function suspendedProfileFixture(h){
  h.run(`location.pathname='/alice';location.href='https://x.com/alice';document.readyState='complete';
    let shown=true,excluded=false,noticeText='Account\\n suspended';
    const notice={get innerText(){return noticeText},closest:()=>excluded?{}:null,
      getBoundingClientRect:()=>({width:shown?300:0,height:60})};
    getComputedStyle=()=>({visibility:'visible',display:'block'});
    const root={querySelectorAll:()=>[notice]};
    document.querySelector=selector=>selector.includes('primaryColumn')?root:null;
    txt=selector=>selector.includes('UserName')?'Alice':'';`);
}

test('suspension requires an explicit visible notice on the target profile even with a header',async()=>{
  const h=harness('content.js');suspendedProfileFixture(h);
  assert.equal((await h.message({type:'PROFILE_READY',handle:'ALICE'})).accountSuspended,true);
  assert.equal((await h.message({type:'COLLECT_PROFILE',handle:'alice'})).accountSuspended,true);
  assert.equal((await h.message({type:'PROFILE_READY',handle:'bob'})).accountSuspended,undefined);
  for(const change of ['shown=false','shown=true;excluded=true',"excluded=false;noticeText='My account suspended yesterday'", "noticeText='Something went wrong'"]){
    h.run(change);
    assert.equal((await h.message({type:'PROFILE_READY',handle:'alice'})).accountSuspended,undefined);
  }
});

for(const last of [false,true]) test(`suspended profile ${last?'completes queue':'advances and remains skipped after reopening'}`,async()=>{
  const page=harness('content.js'),panel=harness('popup.js');await new Promise(setImmediate);
  suspendedProfileFixture(page);
  Object.assign(panel.state,{runState:'running',workflowStep:'loading',workflowHandle:'alice',workflowTabId:1,workflowDue:Date.now()+120000});
  panel.element('handles').value=last?'alice':'alice\nbob';
  panel.ctx.readPage=msg=>page.message(msg);
  panel.run(`tabMessage=async(type,args)=>{
    if(type!=='PROFILE_READY') throw new Error('Suspended account must not be collected or drafted');
    return readPage({type,...args});
  }`);
  await panel.run('workflowTick()');
  assert.equal(panel.state.profiles.alice.processingStatus,'account_suspended');
  assert.ok(panel.state.profiles.alice.accountSuspendedAt);
  assert.equal(panel.state.profiles.alice.contacted,undefined);
  assert.equal(panel.state.workflowHandle,last?null:'bob');
  assert.equal(panel.state.runState,last?'stopped':'running');
  const disk=JSON.parse(JSON.stringify(panel.state));disk.profiles={};
  const reopened=harness('popup.js',disk);await new Promise(setImmediate);
  assert.equal(await reopened.run('nextHandle()'),last?undefined:'bob');
  assert.equal((await reopened.run('db()')).alice.processingStatus,'account_suspended');
});

test('suspension appearing between readiness and collection skips without drafting',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'running',workflowStep:'loading',workflowHandle:'alice',workflowTabId:1,workflowDue:Date.now()+120000});
  h.element('handles').value='alice\nbob';
  h.run(`tabMessage=async type=>type==='PROFILE_READY'?{ok:true}:
    {ok:false,accountSuspended:true,handle:'alice',reason:'Account suspended'};`);
  await h.run('workflowTick()');
  assert.equal(h.state.profiles.alice.processingStatus,'account_suspended');
  assert.equal(h.state.workflowHandle,'bob');
  assert.equal(h.state.runState,'running');
});

for(const stage of ['open_profile','prepared','failed']) test(`suspension during ${stage} is persisted and advances without clicking`,async()=>{
  const page=harness('content.js');await new Promise(setImmediate);suspendedProfileFixture(page);
  Object.assign(page.state,{handles:'alice\nbob',runState:'running',workflowHandle:'alice',workflowStep:'awaiting_prepare',
    workflowCurrent:{handle:'alice'},pendingDmPrepare:{handle:'alice',draft:'Hello',startedAt:'suspended-job',stage,tabId:1}});
  page.run("robustClick=()=>{throw new Error('Must not click')}");
  await page.run('autoPreparePendingDm()');
  assert.equal(page.state.pendingDmPrepare.stage,'account_suspended');
  assert.equal(page.state['processedProfile:alice'].processingStatus,'account_suspended');
  const panel=harness('popup.js',JSON.parse(JSON.stringify(page.state)));await new Promise(setImmediate);
  await panel.run('workflowTick()');
  assert.equal(panel.state.workflowHandle,'bob');
  assert.equal(panel.state.runState,'running');
});

test('suspension appearing while waiting for Message exits preparation promptly',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);suspendedProfileFixture(h);
  h.state.pendingDmPrepare={handle:'alice',draft:'Hello',startedAt:'late-suspension',stage:'open_profile'};
  h.run(`shown=false;domDebug=()=>({});findDmButton=()=>null;
    sleep=async()=>{shown=true};robustClick=()=>{throw new Error('Must not click')};`);
  const result=await h.run('runPrepare('+JSON.stringify(h.state.pendingDmPrepare)+')');
  assert.equal(result.accountSuspended,true);
  assert.equal(h.state.pendingDmPrepare.stage,'account_suspended');
});

test('suspended result from an obsolete job cannot overwrite a replacement job',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);
  h.state.pendingDmPrepare={handle:'bob',startedAt:'new',stage:'prepared'};
  const result=await h.run("markUnusableAccount({handle:'alice',startedAt:'old'},'Account suspended','account_suspended')");
  assert.equal(result.ok,false);
  assert.equal(h.state.pendingDmPrepare.handle,'bob');
  assert.equal(h.state['processedProfile:alice'],undefined);
});

test('saved suspension blocks stale approval even without a current notice',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);
  Object.assign(h.state,{'processedProfile:alice':{handle:'alice',processingStatus:'account_suspended'},
    pendingDmPrepare:{handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'}});
  h.run("domDebug=()=>({});robustClick=()=>{throw new Error('Must not send')}");
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/saved as suspended/);
});

function homeNavigationFixture(h){
  h.run(`let navigations=[];
    chrome.tabs.get=async id=>({id,status:'complete',url:'https://x.com/home'});
    chrome.tabs.update=async(id,update)=>{navigations.push({id,...update});return {id,status:'loading',url:'https://x.com/home',pendingUrl:update.url}};`);
}

test('Start retries an expired loading checkpoint on Home with actual navigation',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);homeNavigationFixture(h);
  Object.assign(h.state,{handles:'alice\nbob',runState:'paused',workflowTabId:1516521890,
    workflowStep:'loading',workflowHandle:'alice',workflowDue:1,workflowNavigationAttempts:3});
  h.element('handles').value='alice\nbob';
  await h.element('start').onclick();
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(navigations)')),[{id:1516521890,url:'https://x.com/alice'}]);
  assert.equal(h.state.runState,'running');
  assert.equal(h.state.workflowStep,'loading');
  assert.equal(h.state.workflowNavigationAttempts,1);
  assert.ok(h.state.workflowDue>Date.now()+110000);
  assert.match(h.state.debugLog,/PROFILE NAVIGATION REQUEST/);
  assert.match(h.state.debugLog,/PROFILE NAVIGATION ACCEPTED/);
});

test('a running legacy loading checkpoint on Home recovers instead of timing out',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);homeNavigationFixture(h);
  Object.assign(h.state,{runState:'running',workflowTabId:1,workflowStep:'loading',workflowHandle:'alice',workflowDue:1});
  await h.run('workflowTick()');
  assert.equal(h.run('navigations.length'),1);
  assert.equal(h.state.runState,'running');
  assert.equal(h.state.workflowNavigationAttempts,1);
  assert.ok(h.state.workflowDue>Date.now()+110000);
});

test('wrong-route retries are spaced and bounded instead of reloading forever',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);homeNavigationFixture(h);
  Object.assign(h.state,{runState:'running',workflowTabId:1,workflowStep:'loading',workflowHandle:'alice',workflowDue:1});
  await h.run('workflowTick()');
  await h.run('workflowTick()');
  assert.equal(h.run('navigations.length'),1);
  for(let attempt=2;attempt<=3;attempt++){
    h.state.workflowNavigationAt=Date.now()-6000;
    await h.run('workflowTick()');
    assert.equal(h.run('navigations.length'),attempt);
  }
  h.state.workflowNavigationAt=Date.now()-6000;
  await h.run('workflowTick()');
  assert.equal(h.run('navigations.length'),3);
  assert.equal(h.state.runState,'paused');
  assert.match(h.element('status').textContent,/after 3 navigation attempts/);
});

for(const inFlight of ['loading','pending']) test(`does not restart ${inFlight} target navigation`,async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);homeNavigationFixture(h);
  Object.assign(h.state,{runState:'running',workflowTabId:1,workflowStep:'loading',workflowHandle:'alice',workflowDue:Date.now()+120000});
  h.run(`chrome.tabs.get=async()=>({id:1,status:'${inFlight==='loading'?'loading':'complete'}',url:'https://x.com/home',pendingUrl:'https://x.com/alice'});`);
  await h.run('workflowTick()');
  assert.equal(h.run('navigations.length'),0);
  assert.equal(h.state.runState,'running');
});

test('navigation rejection is logged with target and pauses without pretending to load',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);homeNavigationFixture(h);
  Object.assign(h.state,{runState:'running',workflowTabId:1,workflowStep:'waiting',workflowHandle:'alice',workflowDue:0});
  h.run("chrome.tabs.update=async()=>{throw new Error('Navigation rejected')}");
  await h.run('workflowTick()');
  assert.equal(h.state.runState,'paused');
  assert.match(h.state.debugLog,/PROFILE NAVIGATION FAILED/);
  assert.match(h.state.debugLog,/https:\/\/x.com\/alice/);
  assert.match(h.element('status').textContent,/Navigation rejected/);
});

for(const text of ['This account doesn’t exist',"This account doesn't exist"]){
  test(`missing notice with a remaining header is collected immediately: ${text}`,async()=>{
    const h=harness('content.js');await new Promise(setImmediate);suspendedProfileFixture(h);
    h.ctx.missingText=text;h.run('noticeText=missingText');
    const result=await h.message({type:'COLLECT_PROFILE',handle:'alice'});
    assert.equal(result.accountNotFound,true);
    assert.equal(result.reason,text);
    assert.equal((await h.message({type:'PROFILE_READY',handle:'bob'})).accountNotFound,undefined);
  });
}

for(const stage of ['open_profile','profile_loaded','prepared','failed']){
  test(`nonexistent account during ${stage} advances without prompts and stays excluded`,async()=>{
    const page=harness('content.js');await new Promise(setImmediate);suspendedProfileFixture(page);
    page.run(`noticeText='This account doesn’t exist';robustClick=()=>{throw new Error('Must not click')};`);
    Object.assign(page.state,{handles:'alice\nbob',runState:'running',workflowHandle:'alice',workflowStep:'awaiting_prepare',
      workflowCurrent:{handle:'alice'},pendingDmPrepare:{handle:'alice',draft:'Hello',startedAt:'missing-account',stage,tabId:1}});
    await page.run('autoPreparePendingDm()');
    assert.equal(page.state.pendingDmPrepare.stage,'account_not_found');
    assert.ok(page.state['processedProfile:alice'].accountNotFoundAt);
    assert.equal(page.state['processedProfile:alice'].contacted,undefined);
    const disk=JSON.parse(JSON.stringify(page.state));disk.profiles={};
    const panel=harness('popup.js',disk);panel.run("alert=()=>{throw new Error('Must not prompt')}");
    await new Promise(setImmediate);await panel.run('workflowTick()');
    assert.equal(panel.state.workflowHandle,'bob');
    assert.equal(panel.state.runState,'running');
    assert.equal((await panel.run('db()')).alice.processingStatus,'account_not_found');
    assert.equal(await panel.run('nextHandle()'),'bob');
  });
}

test('missing-account notice appearing while waiting for Message stops preparation immediately',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);suspendedProfileFixture(h);
  h.state.pendingDmPrepare={handle:'alice',draft:'Hello',startedAt:'late-missing',stage:'open_profile'};
  h.run(`noticeText='This account doesn’t exist';shown=false;domDebug=()=>({});findDmButton=()=>null;
    sleep=async()=>{shown=true};robustClick=()=>{throw new Error('Must not click')};`);
  const result=await h.run('runPrepare('+JSON.stringify(h.state.pendingDmPrepare)+')');
  assert.equal(result.accountNotFound,true);
  assert.equal(h.state.pendingDmPrepare.stage,'account_not_found');
});

test('missing-account notice during approval returns skip result without sending',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);suspendedProfileFixture(h);
  h.state.pendingDmPrepare={handle:'alice',draft:'Hello',startedAt:'missing-approval',stage:'prepared',preparedUrl:'https://x.com/alice'};
  h.run("noticeText='This account doesn’t exist';robustClick=()=>{throw new Error('Must not send')}");
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'Hello'});
  assert.equal(result.ok,true);
  assert.equal(result.unavailable,true);
  assert.equal(result.accountNotFound,true);
  assert.equal(h.state.profiles.alice.processingStatus,'account_not_found');
  assert.equal(h.state.profiles.alice.contacted,undefined);
});

test('saved nonexistent account blocks stale approval without a visible notice',async()=>{
  const h=harness('content.js');await new Promise(setImmediate);
  Object.assign(h.state,{'processedProfile:alice':{handle:'alice',processingStatus:'account_not_found'},
    pendingDmPrepare:{handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'}});
  h.run("domDebug=()=>({});robustClick=()=>{throw new Error('Must not send')}");
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',expectedDraft:'hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/saved as account_not_found/);
});

test('draft length and optional reference reach the actual generation request',async()=>{
  const h=harness('popup.js');
  await new Promise(setImmediate);
  h.element('apiKey').value='test-key';
  h.element('referenceText').value='A distinctive reference passage';
  h.run(`current={handle:'alice',followingStatus:'yes',dmStatus:'yes'};
    let capturedPrompt='';runtimeMessage=async payload=>{capturedPrompt=payload.prompt;return {ok:true,text:'Hello Alice'}};`);
  for(const [mode,range] of [['short','30-45'],['usual','60-90'],['long','150-220']]){
    h.element('messageLength').value=mode;
    h.element('referenceMode').value='off';
    assert.equal(await h.element('draft').onclick(),true);
    assert.ok(h.run('capturedPrompt').includes(range+' words'));
    assert.ok(!h.run('capturedPrompt').includes('A distinctive reference passage'));
  }
  h.element('referenceMode').value='on';
  assert.equal(await h.element('draft').onclick(),true);
  assert.ok(h.run('capturedPrompt').includes('A distinctive reference passage'));
  assert.ok(h.run('capturedPrompt').includes('not instructions'));
});

test('reference upload, passage selection, and clear persist their results',async()=>{
  const h=harness('popup.js');
  await new Promise(setImmediate);
  const input={files:[{name:'example.txt',size:18,text:async()=>'Before chosen after'}],value:'example.txt'};
  await h.element('referenceFile').listeners.change({target:input});
  assert.equal(h.state.referenceText,'Before chosen after');
  assert.equal(input.value,'');
  Object.assign(h.element('referenceText'),{selectionStart:7,selectionEnd:13});
  await h.element('referenceSelection').onclick();
  assert.equal(h.state.referenceText,'chosen');
  await h.element('clearReference').onclick();
  assert.equal(h.state.referenceText,'');
  assert.equal(h.state.referenceMode,'off');
});

test('invalid reference uploads preserve the previous reference',async()=>{
  const h=harness('popup.js',{referenceText:'Keep this'});
  await new Promise(setImmediate);
  for(const file of [
    {name:'document.pdf',size:10,text:async()=>'bad'},
    {name:'empty.txt',size:0,text:async()=>''},
    {name:'large.txt',size:20001,text:async()=>'a'.repeat(20001)},
    {name:'binary.txt',size:5,text:async()=>'a\u0000b'}
  ]){
    await h.element('referenceFile').listeners.change({target:{files:[file],value:file.name}});
    assert.equal(h.state.referenceText,'Keep this');
  }
});

test('staged eligibility requires distinct posts, a follow, and elapsed time',()=>{
  const h=harness('popup.js');
  h.run(`const rules={requiredLikes:2,requiredComments:1,engagementDays:3};
    const events=[{confirmed:true,type:'like',post:'one',at:1000},{confirmed:true,type:'like',post:'one',at:2000},{confirmed:true,type:'comment',post:'one',at:3000},{confirmed:true,type:'follow',post:'',at:4000}];`);
  assert.equal(h.run('engagementEligibility(rules,events,400000000).eligible'),false);
  h.run("events.push({confirmed:true,type:'like',post:'two',at:5000})");
  assert.equal(h.run('engagementEligibility(rules,events,10000).eligible'),false);
  assert.equal(h.run('engagementEligibility(rules,events,1000+3*86400000).eligible'),true);
  assert.equal(h.run("engagementEligibility(rules,events.filter(e=>e.type!=='follow'),400000000).eligible"),false);
});

test('review policies block every DM in no-DM mode and automatic staged sends',async()=>{
  const h=harness('popup.js',{outreachMode:'follow_review'});
  await assert.rejects(h.run("assertReviewDmAllowed('alice')"),/No-DM/);
  Object.assign(h.state,{outreachMode:'staged_review',requiredLikes:0,requiredComments:0,engagementDays:0});
  await assert.rejects(h.run("assertReviewDmAllowed('alice')"),/requirements/);
  h.state['engagement:alice']=[{confirmed:true,type:'follow',post:'',at:Date.now()-1000}];
  await h.run("assertReviewDmAllowed('alice')");
  await assert.rejects(h.run("assertReviewDmAllowed('alice',true)"),/manual approval/);
});

test('no-DM mode blocks draft requests and stops existing automatic workflow',async()=>{
  const h=harness('popup.js',{outreachMode:'follow_review',runState:'running',workflowStep:'drafting',workflowCurrent:{handle:'alice'},workflowCollectedHandle:'alice'});
  await new Promise(setImmediate);
  h.run(`current={handle:'alice',followingStatus:'no',dmStatus:'yes'};
    runtimeMessage=async()=>{throw new Error('Must not generate')};
    tabMessage=async()=>{throw new Error('Must not interact')};`);
  assert.equal(await h.element('draft').onclick(),undefined);
  assert.match(h.element('status').textContent,/No-DM/);
  await h.run('workflowTick()');
  assert.equal(h.state.workflowStep,'drafting');
});

test('content script blocks follow and DM approval in review mode',async()=>{
  const h=harness('content.js',{outreachMode:'follow_review'});
  h.run('domDebug=()=>({})');
  assert.match((await h.message({type:'ENSURE_FOLLOWING'})).error,/engagement queue/);
  assert.match((await h.message({type:'APPROVE_SEND',expectedHandle:'alice'})).error,/No-DM/);
});

function loadReview(h){
  h.run(`document.createElement=()=>({append(){},set textContent(v){},className:''});`);
  h.element('reviewQueue').replaceChildren=()=>{};
  h.element('reviewQueue').append=()=>{};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','review.js'),'utf8'),h.ctx);
}

for(const mode of ['staged_review','engage_follow']) test(`${mode} likes and comments before following then advances`,async()=>{
  const h=harness('popup.js',{outreachMode:mode,handles:'alice\nbob',requiredLikes:1,requiredComments:1,apiKey:'test-key'});
  await new Promise(setImmediate);loadReview(h);await new Promise(setImmediate);
  h.run(`let visits=[],actions=[],now=Date.now();Date=class extends Date {static now(){return now}};
    setTimeout=fn=>{now+=2000;fn();return 0};
    chrome.tabs.query=async()=>[{id:1,url:'https://x.com/home'}];
    chrome.tabs.update=async(id,o)=>visits.push(o.url);
    runtimeMessage=async()=>({ok:true,text:'Relevant reply'});
    tabMessage=async(type,msg)=>{
      if(type==='PROFILE_READY') return {ok:true};
      if(type==='COLLECT_PROFILE') return {ok:true,profile:{handle:msg.handle}};
      actions.push(msg.action+':'+msg.handle);
      if(msg.action==='posts')return {ok:true,posts:[{post:'https://x.com/'+msg.handle+'/status/123',text:'A post'}]};
      const key=ENGAGEMENT_PREFIX+msg.handle,s=await chrome.storage.local.get(key);
      await chrome.storage.local.set({[key]:[...(s[key]||[]),{type:msg.action,post:msg.post||'',confirmed:true,at:Date.now()}]});
      return {ok:true};
    };`);
  await h.element('start').onclick();
  for(let i=0;i<10;i++) await new Promise(setImmediate);
  assert.equal(h.run('JSON.stringify(visits)'),JSON.stringify(['https://x.com/alice','https://x.com/bob']));
  assert.equal(h.run('JSON.stringify(actions)'),JSON.stringify(['posts:alice','like:alice','comment:alice','follow:alice','posts:bob','like:bob','comment:bob','follow:bob']));
  assert.equal(h.state.runState,'paused');
  assert.equal(h.state['engagement:bob'].length,3);
});

test('toolbar Start hands an automatic job to the side panel',async()=>{
  const h=harness('popup.js',{outreachMode:'follow_review',handles:'alice'});
  await new Promise(setImmediate);loadReview(h);await new Promise(setImmediate);
  h.run(`document.body.classList.contains=()=>false;let actions=[];
    chrome.tabs.query=async()=>[{id:1,windowId:7,url:'https://x.com/home'}];
    chrome.sidePanel={open:async options=>actions.push('panel:'+options.windowId)};`);
  await h.element('start').onclick();
  assert.equal(h.run('JSON.stringify(actions)'),JSON.stringify(['panel:7']));
  assert.equal(h.state.runState,'running');
  assert.ok(h.state.engagementRunId);
  assert.equal(h.state.autoSend,false);
});

test('workflow explanation survives reopening and changes with the selected mode',async()=>{
  const h=harness('popup.js',{outreachMode:'staged_review',handles:'alice',reviewHandle:'alice'});
  await new Promise(setImmediate);loadReview(h);await new Promise(setImmediate);
  assert.match(h.element('workflowHelp').textContent,/runs the profile queue automatically/);
  h.element('outreachMode').value='standard';
  await h.element('outreachMode').listeners.change();
  assert.equal(h.element('start').textContent,'Start');
  assert.match(h.element('workflowHelp').textContent,/each prepared DM waits for Send & Next/);
});

test('legacy manual records never count as confirmed actions or DM eligibility',async()=>{
  const h=harness('popup.js',{outreachMode:'staged_review',handles:'alice',reviewHandle:'alice',requiredLikes:0,requiredComments:0,engagementDays:0,
    'engagement:alice':[{type:'follow',post:'',at:1000}]});
  await new Promise(setImmediate);loadReview(h);await new Promise(setImmediate);
  assert.equal(h.run("engagementComplete(chromeState,'alice')".replace('chromeState',JSON.stringify(h.state))),false);
  assert.match(h.element('engagementStatus').textContent,/1 old manual records excluded/);
  await assert.rejects(h.run("assertReviewDmAllowed('alice')"),/requirements/);
});

function loadEngagement(h){
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','engagement.js'),'utf8'),h.ctx);
}
function engagementFixture(){
  const h=harness('content.js',{outreachMode:'staged_review',runState:'running',engagementRunId:'run',workflowTabId:1,reviewHandle:'alice'});
  loadEngagement(h);
  h.run(`location.pathname='/alice';collectProfile=()=>({handle:'alice'});
    let liked=false,clicks=0;const button={isConnected:true,click(){clicks++;liked=true}};
    const article={querySelector:s=>s==='[data-testid="unlike"]'?(liked?{}:null):button};
    engagementPosts=()=>[{post:'https://x.com/alice/status/123',text:'Hello',article}];
    waitForElement=async fn=>fn();`);
  return h;
}
const likeJob={type:'ENGAGEMENT',runId:'run',handle:'alice',action:'like',post:'https://x.com/alice/status/123'};
test('like clicks X once, verifies Unlike, and deduplicates confirmed records',async()=>{
  const h=engagementFixture();
  assert.equal((await h.message(likeJob)).ok,true);
  assert.equal((await h.message(likeJob)).ok,true);
  assert.equal(h.run('clicks'),1);
  assert.equal(h.state['engagement:alice'].length,1);
  assert.equal(h.state['engagement:alice'][0].confirmed,true);
});
test('an unconfirmed like does not create a completion event',async()=>{
  const h=engagementFixture();h.run('button.click=()=>{clicks++}');
  const result=await h.message(likeJob);
  assert.equal(result.ok,false);assert.match(result.error,/did not confirm/);
  assert.equal(h.state['engagement:alice'],undefined);
});
for(const change of [{runState:'paused'},{engagementRunId:'stale'},{workflowTabId:2},{reviewHandle:'bob'}])test('engagement guard prevents stale or paused clicks '+JSON.stringify(change),async()=>{
  const h=engagementFixture();Object.assign(h.state,change);
  assert.equal((await h.message(likeJob)).ok,false);
  assert.equal(h.run('clicks'),0);
});
test('actual follow is verified before writing its event',async()=>{
  const h=engagementFixture();h.run(`relationship=()=>({followingStatus:clicks?'yes':'no'});
    findFollowButton=()=>button;robustClick=b=>b.click();sleep=async()=>{};domDebug=()=>({});`);
  assert.equal((await h.message({...likeJob,action:'follow'})).ok,true);
  assert.equal(h.run('clicks'),1);
  assert.equal(h.state['engagement:alice'][0].type,'follow');
});
test('unconfirmed comment markers prevent repeat submission',async()=>{
  const h=engagementFixture();h.state['pendingComment:'+likeJob.post]={text:'Hello'};
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,false);assert.match(result.error,/not be submitted twice/);
  assert.equal(h.run('clicks'),0);
});

test('timeline highlights only listed authors and removes highlights when disabled',async()=>{
  const h=harness('content.js',{timelineMonitoring:'on',handles:'Alice'});
  h.run(`location.pathname='/home';let badge=null,matched=false;
    const article={querySelector:s=>s==='[data-sin-review-badge]'?badge:{href:'https://x.com/alice/status/123'},
      toggleAttribute:(name,value)=>{matched=value},prepend:b=>{badge=b}};
    document.querySelectorAll=()=>[article];
    document.createElement=()=>({setAttribute(){},style:{},remove(){badge=null}});`);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','timeline.js'),'utf8'),h.ctx);
  await new Promise(setImmediate);
  assert.equal(h.run('matched'),true);
  assert.equal(h.run('badge.textContent'),'X Power User Plugin review list: @alice');
  h.state.handles='bob';await h.run('highlightTimelineMatches()');
  assert.equal(h.run('matched'),false);
  assert.equal(h.run('badge'),null);
  h.state.handles='alice';h.state.timelineMonitoring='off';await h.run('highlightTimelineMatches()');
  assert.equal(h.run('matched'),false);
});

test('USA location filter accepts explicit forms and rejects ambiguous or unsupported locations',()=>{
  const h=harness('popup.js');
  for(const location of ['USA','United States','U.S.A.','California','Austin, TX','Atlanta, Georgia, USA','New York, NY','Washington, DC']){
    assert.equal(h.run(`statedUsLocation(${JSON.stringify(location)})`),true,location);
  }
  for(const location of ['', 'Georgia','CA','New York / London','London, UK','Toronto, Ontario','Earth','Paris','USA / Canada','Not USA']){
    assert.equal(h.run(`statedUsLocation(${JSON.stringify(location)})`),false,location);
  }
});

test('follower review parses displayed counts, enforces limits and follow-back, and defaults on',()=>{
  const h=harness('popup.js');
  assert.equal(h.run("followerCount('1.2K Followers')"),1200);
  assert.equal(h.run("followerCount('1,234')"),1234);
  assert.equal(h.run("followerCount('2M')"),2000000);
  assert.equal(h.run("followerCount('12,34')"),null);
  assert.equal(h.run("audienceReview({}, {location:'USA',followers:'0'}).eligible"),true);
  for(const expr of [
    "audienceReview({}, {location:'UK',followers:'1000'})",
    "audienceReview({}, {location:'USA',followers:''})",
    "audienceReview({minFollowers:100}, {location:'USA',followers:'99'})",
    "audienceReview({maxFollowers:999}, {location:'USA',followers:'1K'})",
    "audienceReview({minFollowers:100,maxFollowers:10}, {location:'USA',followers:'50'})",
    "audienceReview({requireFollowBack:'on'}, {location:'USA',followers:'1000',followsYou:false})"
  ]) assert.equal(h.run(expr+'.eligible'),false,expr);
  assert.equal(h.run("audienceReview({minFollowers:100,maxFollowers:1000,requireFollowBack:'on'},{location:'USA',followers:'1K',followsYou:true}).eligible"),true);
});

for(const profile of [{location:'UK',followers:'1000'}, {location:'USA',followers:''}, {location:'USA',followers:'9'}]){
  test(`failed audience review skips and advances without follow or draft: ${JSON.stringify(profile)}`,async()=>{
    const h=harness('popup.js',{usaOnly:'on',followerReview:'on',minFollowers:10});await new Promise(setImmediate);
    h.element('handles').value='alice\nbob';
    Object.assign(h.state,{runState:'running',autoSend:true,workflowTabId:1,workflowStep:'loading',workflowHandle:'alice',workflowDue:Date.now()+120000});
    h.run(`tabMessage=async type=>{
      if(type==='PROFILE_READY') return {ok:true};
      if(type==='COLLECT_PROFILE') return {ok:true,profile:{handle:'alice',followingStatus:'no',dmStatus:'yes',...${JSON.stringify(profile)}}};
      throw new Error('Unexpected action: '+type);
    };runtimeMessage=async()=>{throw new Error('Must not draft')};`);
    await h.run('workflowTick()');
    assert.equal(h.state.profiles.alice.processingStatus,'skipped');
    assert.match(h.state.profiles.alice.eligibilityReason,/review:/);
    assert.equal(h.state.workflowHandle,'bob');
    assert.equal(h.state.runState,'running');
    assert.equal(h.state['processedProfile:alice'].processingStatus,'skipped');
  });
}

test('live follow guard rejects wrong recipient and foreign location, then follows an eligible profile once',async()=>{
  const h=harness('content.js',{usaOnly:'on',followerReview:'on',minFollowers:100});
  h.run(`let clicks=0;let profile={handle:'bob',location:'USA',followers:'1K'};
    collectProfile=()=>profile;relationship=()=>({followingStatus:clicks?'yes':'no'});
    const button={click(){clicks++}};findFollowButton=()=>button;domDebug=()=>({});sleep=async()=>{};`);
  assert.equal((await h.message({type:'ENSURE_FOLLOWING',handle:'alice'})).ok,false);
  h.run("profile={handle:'alice',location:'UK',followers:'1K'}");
  assert.equal((await h.message({type:'ENSURE_FOLLOWING',handle:'alice'})).ok,false);
  assert.equal(h.run('clicks'),0);
  h.run("profile.location='USA'");
  assert.equal((await h.message({type:'ENSURE_FOLLOWING',handle:'alice'})).ok,true);
  assert.equal((await h.message({type:'ENSURE_FOLLOWING',handle:'alice'})).alreadyFollowing,true);
  assert.equal(h.run('clicks'),1);
});

test('new audience settings block a prepared automatic DM before Send',async()=>{
  const h=harness('content.js',{profiles:{alice:{handle:'alice',location:'UK',followers:'1K'}},runState:'running',autoSend:true});
  h.state.pendingDmPrepare={handle:'alice',stage:'prepared',draft:'hello',preparedUrl:'https://x.com/i/chat/123'};
  h.run(`let clicks=0;domDebug=()=>({});robustClick=()=>{clicks++}`);
  h.state.usaOnly='on';
  const result=await h.message({type:'APPROVE_SEND',expectedHandle:'alice',automatic:true});
  assert.equal(result.ok,false);
  assert.match(result.error,/USA-only/);
  assert.equal(h.run('clicks'),0);
});

test('eligible USA queue reviews, follows, drafts and automatically sends without per-profile clicks',async()=>{
  const h=harness('popup.js',{usaOnly:'on',followerReview:'on',minFollowers:100,maxFollowers:2000,requireFollowBack:'on'});
  await new Promise(setImmediate);
  h.element('handles').value='alice';h.element('apiKey').value='test-key';
  Object.assign(h.state,{autoSend:true,runState:'running',workflowStep:'loading',workflowHandle:'alice',workflowTabId:1,workflowDue:Date.now()+120000});
  h.run(`let calls=[],followed=false;setTimeout=fn=>{fn();return 0};
    runtimeMessage=async()=>{calls.push('DRAFT');return {ok:true,text:'Hello Alice'}};
    tabMessage=async type=>{
      calls.push(type);
      if(type==='COLLECT_PROFILE') return {ok:true,profile:{handle:'alice',location:'Austin, TX',followers:'1K',followsYou:true,followingStatus:followed?'yes':'no',dmStatus:'yes'}};
      if(type==='ENSURE_FOLLOWING'){followed=true;return {ok:true,followedNow:true}};
      if(type==='PREPARE_FROM_PROFILE'){
        const p=(await chrome.storage.local.get('pendingDmPrepare')).pendingDmPrepare;
        await chrome.storage.local.set({pendingDmPrepare:{...p,stage:'prepared'}});
      }
      return {ok:true};
    };`);
  for(let i=0;i<5;i++) await h.run('workflowTick()');
  assert.equal(h.state.runState,'stopped');
  assert.equal(h.state.profiles.alice.contacted,true);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(calls)')),['PROFILE_READY','COLLECT_PROFILE','ENSURE_FOLLOWING','COLLECT_PROFILE','DRAFT','PREPARE_FROM_PROFILE','APPROVE_SEND']);
});

test('ready profile progresses while background page resources are still loading',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  Object.assign(h.state,{runState:'running',workflowTabId:1,workflowStep:'loading',workflowHandle:'alice',workflowDue:Date.now()+120000});
  h.run(`chrome.tabs.get=async()=>({id:1,status:'loading',url:'https://x.com/alice'});
    tabMessage=async type=>type==='PROFILE_READY'?{ok:true}:{ok:true,profile:{handle:'alice',followingStatus:'yes',dmStatus:'yes'}};`);
  await h.run('workflowTick()');
  assert.equal(h.state.workflowStep,'drafting');
  assert.equal(h.state.workflowCollectedHandle,'alice');
});

function followControlsFixture(h){
  h.run(`visible=()=>true;
    const control=(text,id='',excluded=false)=>({innerText:text,getAttribute:key=>key==='data-testid'?id:key==='aria-label'?text:'',closest:()=>excluded?{}:null});
    const target=control('Follow'),suggestion=control('Following','999-unfollow',true),post=control('Following','888-unfollow',true);
    let controls=[suggestion,post,target];
    const root={querySelectorAll:selector=>selector==='span,div'?[]:controls};
    document.querySelector=()=>root;`);
}

test('profile follow state ignores suggestions and posts and accepts duplicated accessible labels',()=>{
  const h=harness('content.js');followControlsFixture(h);
  assert.equal(h.run('relationship().followingStatus'),'no');
  assert.equal(h.run('findFollowButton()===target'),true);
  h.run("target.innerText='Following';target.getAttribute=key=>key==='aria-label'?'Following':''");
  assert.equal(h.run('relationship().followingStatus'),'yes');
});

test('a suggested account is never used as the profile Follow button',()=>{
  const h=harness('content.js');followControlsFixture(h);
  h.run("controls=[control('Follow','999-follow',true)]");
  assert.equal(h.run('relationship().followingStatus'),'unknown');
  assert.equal(h.run('findFollowButton()'),null);
});

test('late profile Follow control is awaited and clicked only once',async()=>{
  const h=harness('content.js');
  h.run(`let now=0,clicks=0;Date=class extends Date{static now(){return now}};
    sleep=async ms=>{now+=ms};location.pathname='/alice';domDebug=()=>({});
    collectProfile=()=>({handle:'alice'});
    relationship=()=>({followingStatus:clicks?'yes':now>=2000?'no':'unknown'});
    findFollowButton=()=>({click(){clicks++}});`);
  const result=await h.message({type:'ENSURE_FOLLOWING',handle:'alice'});
  assert.equal(result.followedNow,true);
  assert.equal(h.run('clicks'),1);
  assert.ok(h.run('now')>=2000);
});

for(const followState of ['unknown','no']) test('unconfirmed follow is an explicit failure: '+followState,async()=>{
  const h=harness('content.js');
  h.run(`let now=0,clicks=0;Date=class extends Date{static now(){return now}};
    sleep=async ms=>{now+=ms};location.pathname='/alice';domDebug=()=>({});
    collectProfile=()=>({handle:'alice'});
    relationship=()=>({followingStatus:'${followState}'});
    findFollowButton=()=>({click(){clicks++}});`);
  const result=await h.message({type:'ENSURE_FOLLOWING',handle:'alice'});
  assert.equal(result.ok,false);
  assert.equal(h.run('clicks'),followState==='no'?1:0);
  assert.match(result.error,/did not appear|did not confirm/);
  assert.ok(h.run('now')<=10000);
});

test('unknown follow state is checked before drafting and failure blocks generation',async()=>{
  const h=harness('popup.js');await new Promise(setImmediate);
  h.run(`current={handle:'alice',followingStatus:'unknown'};let checked=false;
    ensureFollowed=async()=>{checked=true;return {ok:false,error:'Follow control missing'}};
    runtimeMessage=async()=>{throw new Error('Must not draft before follow check')};`);
  assert.equal(await h.element('draft').onclick(),undefined);
  assert.equal(h.run('checked'),true);
  assert.match(h.element('status').textContent,/Follow control missing/);
});

test('comment publishes once and counts only after X returns a new post receipt',async()=>{
  const h=replyFixture();
  const result=await h.message({...likeJob,action:'comment',text:'Interesting observation.'});
  assert.equal(result.ok,true);
  assert.equal(h.run('submitted'),1);
  assert.equal(h.state['engagement:alice'][0].type,'comment');
  assert.equal(h.state['pendingComment:'+likeJob.post],undefined);
  h.run("opened=false;location.pathname='/alice'");
  await h.message({...likeJob,action:'comment',text:'Interesting observation.'});
  assert.equal(h.run('submitted'),1);
});

test('comment without a receipt preserves its marker and does not count',async()=>{
  const h=replyFixture();
  h.run('document.querySelectorAll=()=>[]');
  const result=await h.message({...likeJob,action:'comment',text:'Interesting observation.'});
  assert.equal(result.ok,false);
  assert.match(result.error,/no automatic retry/);
  assert.ok(h.state['pendingComment:'+likeJob.post]);
  assert.equal(h.state['engagement:alice'],undefined);
  h.run("opened=false;location.pathname='/alice'");
  await h.message({...likeJob,action:'comment',text:'Interesting observation.'});
  assert.equal(h.run('submitted'),1);
});

function postScannerFixture(){
  const h=harness('content.js');loadEngagement(h);
  h.run(`function postArticle(author,id,{pinned=false,reposted=false,quotedAuthor=null}={}){
    const article={};
    const link={href:'https://x.com/'+author+'/status/'+id,parentElement:{closest:()=>null}};
    const time={closest:s=>s==='article'?article:link};
    const quotedLink={href:'https://x.com/'+quotedAuthor+'/status/999',parentElement:{closest:()=>({})}};
    const quotedTime={closest:s=>s==='article'?article:quotedLink};
    article.querySelectorAll=s=>s==='time'?[time,...(quotedAuthor?[quotedTime]:[])]:[];
    // The timestamp link is outside User-Name, as in an alternate X layout.
    article.querySelector=s=>s==='[data-testid="socialContext"]'?(pinned?{innerText:'Pinned'}:reposted?{innerText:'Alice reposted'}:null):
      s==='[data-testid="tweetText"]'?{innerText:'Original text'}:null;
    return article;
  }`);
  return h;
}
test('post scanner finds timestamp links outside User-Name and includes pinned originals',()=>{
  const h=postScannerFixture();
  h.run(`document.querySelectorAll=()=>[postArticle('Alice',123,{pinned:true}),postArticle('alice',124)];`);
  assert.equal(h.run("JSON.stringify(engagementPosts('alice').map(p=>p.post))"),JSON.stringify(['https://x.com/Alice/status/123','https://x.com/alice/status/124']));
});
test('post scanner excludes reposts and never mistakes a quoted target for the outer author',()=>{
  const h=postScannerFixture();
  h.run(`document.querySelectorAll=()=>[postArticle('alice',123,{reposted:true}),postArticle('bob',124,{quotedAuthor:'alice'})];`);
  assert.equal(h.run("engagementPosts('alice').length"),0);
});
async function queueFailureFixture(settings,profile,posts){
  const h=harness('popup.js',{outreachMode:'staged_review',handles:'alice\nbob',requiredLikes:1,requiredComments:0,...settings});
  await new Promise(setImmediate);loadReview(h);await new Promise(setImmediate);
  h.run(`let visits=[],actions=[],now=Date.now();Date=class extends Date {static now(){return now}};
    setTimeout=fn=>{now+=2000;fn();return 0};
    chrome.tabs.query=async()=>[{id:1,url:'https://x.com/home'}];
    chrome.tabs.update=async(id,o)=>visits.push(o.url);
    tabMessage=async(type,msg)=>{
      if(type==='PROFILE_READY') return {ok:true};
      if(type==='COLLECT_PROFILE') return {ok:true,profile:{handle:msg.handle,...${JSON.stringify(profile)}}};
      actions.push(msg.action+':'+msg.handle);
      if(msg.action==='posts')return {ok:true,posts:${JSON.stringify(posts)},loadedArticles:3};
      return {ok:true};
    };`);
  await h.element('start').onclick();
  for(let i=0;i<10;i++) await new Promise(setImmediate);
  return h;
}
test('empty post scans pause on the current profile instead of silently advancing',async()=>{
  const h=await queueFailureFixture({}, {}, []);
  assert.equal(h.run('JSON.stringify(visits)'),JSON.stringify(['https://x.com/alice']));
  assert.equal(h.state.runState,'paused');
  assert.match(h.state['engagementOutcome:alice'].reason,/no eligible original posts among 3 loaded articles/);
  assert.match(h.element('engagementStatus').textContent,/PAUSED/);
});
test('audience rejection persists the precise skip reason and summarizes filtered profiles',async()=>{
  const h=await queueFailureFixture({usaOnly:'on'}, {location:'Earth'}, []);
  assert.equal(h.run('actions.length'),0);
  assert.equal(h.state['engagementOutcome:alice'].state,'filtered');
  assert.match(h.state['engagementOutcome:alice'].reason,/USA-only/);
  assert.match(h.state['engagementOutcome:bob'].reason,/USA-only/);
  assert.match(h.element('status').textContent,/0 completed, 2 filtered out/);
});
test('follow-only mode explicitly labels its start buttons and explains that likes are disabled',async()=>{
  const h=harness('popup.js',{outreachMode:'follow_review'});
  await new Promise(setImmediate);loadReview(h);await new Promise(setImmediate);
  assert.equal(h.element('start').textContent,'Start automatic follows');
  assert.equal(h.element('reviewNext').textContent,'Start automatic follows');
  assert.match(h.element('workflowHelp').textContent,/Likes and comments are disabled/);
});

for(const mode of ['staged_review','engage_follow']) test(`${mode} does not follow when post requirements are incomplete`,async()=>{
  const h=await queueFailureFixture({outreachMode:mode}, {}, [{post:'https://x.com/alice/status/123',text:'A post'}]);
  assert.equal(h.state.runState,'paused');
  assert.equal(h.run("actions.some(a=>a.startsWith('follow:'))"),false);
  assert.match(h.state['engagementOutcome:alice'].reason,/configured engagement is incomplete/);
});
test('engage then follow mode blocks DM preparation and sending',async()=>{
  const h=harness('content.js',{outreachMode:'engage_follow'});
  await assert.rejects(h.run("assertReviewDmAllowed('alice')"),/No-DM/);
  await assert.rejects(h.run("assertReviewDmAllowed('alice',true)"),/No-DM/);
});

test('LLM response handler removes em dashes from messages and all metadata before returning',async()=>{
  const h=harness('background.js');
  h.run(`AbortSignal={timeout:()=>null};let request;
    fetch=async(url,options)=>{
      request=JSON.parse(options.body);
      return {ok:true,text:async()=>JSON.stringify({status:'completed',output_text:JSON.stringify({
        message:'Hello — great post―thanks',personalization_basis:'Art—design',
        greeting_context:'Morning — local',safety_check:'passed',
        nested:{items:['One—two',null,7]}
      })})};
    };`);
  const result=await h.message({type:'OPENAI_DRAFT',apiKey:'test-key',prompt:'Write a reply'});
  assert.equal(result.ok,true);
  assert.equal(result.text,'Hello, great post, thanks');
  assert.equal(result.structured.personalization_basis,'Art, design');
  assert.equal(result.structured.greeting_context,'Morning, local');
  assert.equal(result.structured.nested.items[0],'One, two');
  assert.equal(result.structured.nested.items[1],null);
  assert.equal(result.structured.nested.items[2],7);
  assert.doesNotMatch(JSON.stringify(result),/[\u2014\u2015]/);
  assert.match(h.run('request.instructions'),/Do not use em dashes/);
});

test('LLM normalization preserves hyphens and line breaks',()=>{
  const h=harness('background.js');
  assert.equal(h.run("cleanLlmOutput('one-to-one\\nNew paragraph')"),'one-to-one\nNew paragraph');
});

test('extension updates reload existing X tabs so stale content scripts are replaced',()=>{
  const h=harness('background.js');
  h.run(`let reloaded=[];
    chrome.tabs.query=(query,done)=>done([{id:11},{id:12}]);
    chrome.tabs.reload=(id,done)=>{reloaded.push(id);done()}`);
  h.dispatchInstalled({reason:'update'});
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(reloaded)')),[11,12]);
});

test('accepted editor insertion does not dispatch a second insertion before React renders',async()=>{
  const h=harness('content.js');
  h.run(`let inserted=0,events=0;const box={tagName:'DIV',textContent:'',focus(){},dispatchEvent(){events++;return true}};
    window.getSelection=()=>({removeAllRanges(){},addRange(){}});
    document.createRange=()=>({selectNodeContents(){}});
    document.execCommand=()=>{inserted++;return true};`);
  await h.run("insertIntoComposer(box,'Hello')");
  assert.equal(h.run('inserted'),1);
  assert.equal(h.run('events'),0);
});

test('editor-handled beforeinput does not trigger a duplicate fallback',async()=>{
  const h=harness('content.js');
  h.run(`let events=[];sleep=async()=>{};InputEvent=class {constructor(type){this.type=type}};
    const box={tagName:'DIV',textContent:'',focus(){},dispatchEvent(event){events.push(event.type);return false}};
    window.getSelection=()=>({removeAllRanges(){},addRange(){}});
    document.createRange=()=>({selectNodeContents(){}});document.execCommand=()=>false;`);
  await h.run("insertIntoComposer(box,'Hello')");
  assert.equal(h.run('JSON.stringify(events)'),JSON.stringify(['beforeinput']));
  assert.equal(h.run('box.textContent'),'');
});

function replyFixture(){
  const h=engagementFixture();
  h.state.profiles={alice:{handle:'alice'}};
  h.run(`let now=Date.now(),opened=false,submitted=0;
    Date=class extends Date {static now(){return now}};sleep=async ms=>{now+=ms};
    const box={value:'',isConnected:true};
    const submit={isConnected:true,disabled:false,getAttribute:()=>null,click(){submitted++}};
    const dialog={isConnected:true,querySelector:s=>s.includes('tweetTextarea')?box:submit,
      querySelectorAll:()=>[{href:'https://x.com/alice/status/123'}]};
    box.closest=()=>dialog;
    button.click=()=>{opened=true;location.pathname='/compose/post'};
    document.querySelector=s=>opened?(s.includes('tweetTextarea')?box:dialog):null;
    document.querySelectorAll=()=>submitted?[{href:'https://x.com/me/status/456'}]:[];
    insertIntoComposer=async(b,text)=>{b.value=text};
    waitForElement=async(fn,timeout=1000)=>{for(let i=0;i<=timeout/200;i++){const result=fn();if(result)return result;await sleep(200)}return null};`);
  return h;
}
test('reply survives compose URL, waits for stable text, and submits once with a receipt',async()=>{
  const h=replyFixture();
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,true,result.error);
  assert.equal(h.run('submitted'),1);
  assert.equal(h.state['engagement:alice'][0].type,'comment');
  assert.equal(h.state['pendingComment:'+likeJob.post],undefined);
});
test('reply waits one second after text insertion before looking for the submit button',async()=>{
  const h=replyFixture();
  h.run(`let insertedAt=null,firstSubmitQueryAt=null;
    insertIntoComposer=async(b,text)=>{b.value=text;insertedAt=Date.now()};
    dialog.querySelector=s=>{
      if(s.includes('tweetTextarea')) return box;
      firstSubmitQueryAt??=Date.now();
      return submit;
    };`);
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,true,result.error);
  assert.ok(h.run('firstSubmitQueryAt-insertedAt')>=1000);
});
test('reply pauses before the actual submit click',async()=>{
  const h=replyFixture();
  h.run(`let readyAt=null,clickedAt=null;
    submit.click=()=>{clickedAt=Date.now();submitted++};
    dialog.querySelector=s=>{
      if(s.includes('tweetTextarea')) return box;
      readyAt??=Date.now();
      return submit;
    };`);
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,true,result.error);
  assert.ok(h.run('clickedAt-readyAt')>=2300);
});
test('duplicated reply is never submitted or marked pending',async()=>{
  const h=replyFixture();h.run('insertIntoComposer=async(b,text)=>{b.value=text+text}');
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/not ready/);
  assert.equal(h.run('submitted'),0);
  assert.equal(h.state['pendingComment:'+likeJob.post],undefined);
});
test('reply dialog for a different post cannot bypass the navigation guard',async()=>{
  const h=replyFixture();h.run("dialog.querySelectorAll=()=>[{href:'https://x.com/bob/status/999'}]");
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/reply composer shows a different post/);
  assert.equal(h.run('submitted'),0);
});


test('reply dialog without a status link stays bound to the post whose Reply was clicked',async()=>{
  const h=replyFixture();h.run('dialog.querySelectorAll=()=>[]');
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,true,result.error);
  assert.equal(h.run('submitted'),1);
});
test('reply guard uses the composer dialog instead of an outer dialog wrapper',async()=>{
  const h=replyFixture();
  h.run(`const originalQuery=document.querySelector;
    document.querySelector=s=>opened&&s==='[role="dialog"]'?{}:originalQuery(s);`);
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,true,result.error);
  assert.equal(h.run('submitted'),1);
});
test('reply permalink accepts media suffixes and tracking parameters',async()=>{
  const h=replyFixture();h.run("dialog.querySelectorAll=()=>[{href:'https://x.com/Alice/status/123/photo/1?s=20'}]");
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,true,result.error);
});
test('a replaced reply dialog does not inherit the original target binding',async()=>{
  const h=replyFixture();
  h.run(`insertIntoComposer=async(b,text)=>{b.value=text;box.closest=()=>({...dialog})}`);
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/closed or replaced/);
  assert.equal(h.run('submitted'),0);
  assert.equal(h.state['pendingComment:'+likeJob.post],undefined);
});
test('a detached Reply button cannot bind a new composer',async()=>{
  const h=replyFixture();h.run('button.isConnected=false');
  const result=await h.message({...likeJob,action:'comment',text:'Hello'});
  assert.equal(result.ok,false);
  assert.match(result.error,/Target post changed/);
  assert.equal(h.run('opened'),false);
});

test('diagnostic storage failures do not reject and logging recovers',async()=>{
  const h=harness('content.js');
  await h.run('contentLogQueue');
  h.run(`const originalSet=chrome.storage.local.set;
    chrome.storage.local.set=async()=>{throw new Error('Storage unavailable')}`);
  await assert.doesNotReject(h.run("appendPersistentLog('FAILED WRITE')"));
  h.run('chrome.storage.local.set=originalSet');
  await h.run("appendPersistentLog('RECOVERED WRITE')");
  assert.match(h.state.contentDebugLog,/RECOVERED WRITE/);
});

test('startup storage rejection is contained without creating a preparation job',async()=>{
  const h=harness('content.js');
  await h.run('contentLogQueue');
  h.run(`chrome.runtime.id='test-extension';
    chrome.storage.local.get=async()=>{throw new Error('Storage unavailable')}`);
  await assert.doesNotReject(h.run('resumePendingDmSafely()'));
  assert.equal(h.state.pendingDmPrepare,undefined);
  assert.equal(h.run('preparing'),false);
});

test('disconnected content script stops resume timers without touching storage',async()=>{
  const h=harness('content.js');
  await h.run('contentLogQueue');
  h.run(`let storageReads=0,clearedTimers=0;
    chrome.runtime.id=undefined;
    chrome.storage.local.get=()=>{storageReads++;throw new Error('Extension context invalidated.')};
    clearTimeout=()=>clearedTimers++;clearInterval=()=>clearedTimers++`);
  await assert.doesNotReject(h.run('resumePendingDmSafely()'));
  assert.equal(h.run('storageReads'),0);
  assert.equal(h.run('clearedTimers'),2);
});

test('disconnect during resume contains failures from both work and error reporting',async()=>{
  const h=harness('content.js');
  await h.run('contentLogQueue');
  Object.assign(h.state,{pendingDmPrepare:{handle:'alice',draft:'hello',stage:'open_profile'}});
  h.run(`chrome.runtime.id='test-extension';
    assertReviewDmAllowed=async()=>{
      chrome.runtime.id=undefined;
      chrome.storage.local.get=async()=>{throw new Error('Extension context invalidated.')};
      throw new Error('Extension context invalidated.');
    }`);
  await assert.doesNotReject(h.run('resumePendingDmSafely()'));
  assert.equal(h.state.pendingDmPrepare.stage,'open_profile');
  assert.equal(h.run('preparing'),false);
});

test('in-flight Chrome API rejection after reload is consumed and stops content work',()=>{
  const h=harness('content.js');
  let prevented=false;
  h.run('let stoppedTimers=0;clearTimeout=()=>stoppedTimers++;clearInterval=()=>stoppedTimers++');
  h.dispatchWindow('unhandledrejection',{reason:new Error('Extension context invalidated.'),preventDefault(){prevented=true}});
  assert.equal(prevented,true);
  assert.equal(h.run('stoppedTimers'),2);
});
