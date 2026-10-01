const CONTENT_BUILD = '1.9.35';
let prepareStartupTimer=null,prepareResumeTimer=null;
function extensionContextInvalidated(error){
  return /extension context invalidated/i.test(String(error?.message||error||''));
}
function stopContentWork(){
  clearTimeout(prepareStartupTimer);
  clearInterval(prepareResumeTimer);
}
function txt(sel){return document.querySelector(sel)?.innerText?.trim()||''}
function countFrom(suffix){const a=[...document.querySelectorAll(`a[href$="/${suffix}"]`)][0];return a?.innerText?.trim()||''}
function allText(el){return ((el?.getAttribute?.('aria-label')||'')+' '+(el?.getAttribute?.('title')||'')+' '+(el?.innerText||'')).trim()}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function normHandle(s){return String(s||'').trim().replace(/^@/,'').toLowerCase()}
function visible(el){if(!el)return false;const r=el.getBoundingClientRect();const st=getComputedStyle(el);return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none'}

// Only the profile controls count, not timeline authors or recommendation cards.
function profileControlRoot(){return document.querySelector('[data-testid="primaryColumn"]')||document.querySelector('main')||document}
function isProfileControl(el){return !el.closest?.('article,[data-testid="UserCell"],aside,[role="dialog"]')}
function followControlState(el){
  const id=el.getAttribute?.('data-testid')||'';
  // X can repeat the same label in visible text and aria-label; match each separately.
  const labels=[el.innerText,el.getAttribute?.('aria-label'),el.getAttribute?.('title')].map(x=>String(x||'').trim());
  if(/(^|[-_])unfollow$/i.test(id)||labels.some(x=>/^(following|unfollow)(?:\s+@\w+)?$/i.test(x))) return 'yes';
  if(/(^|[-_])follow$/i.test(id)||labels.some(x=>/^follow(?:\s+@\w+)?$/i.test(x))) return 'no';
  return 'unknown';
}
function profileFollowControls(){
  return [...profileControlRoot().querySelectorAll('button,[role="button"],a')].filter(el=>visible(el)&&isProfileControl(el));
}
function relationship(){
  const candidates=profileFollowControls().map(el=>({text:allText(el),testid:el.getAttribute?.('data-testid')||'',status:followControlState(el)})).filter(x=>x.status!=='unknown');
  const status=candidates.find(x=>x.status==='yes')?'yes':candidates.length?'no':'unknown';
  const followsYou=[...profileControlRoot().querySelectorAll('span,div')].some(el=>isProfileControl(el)&&/^follows you$/i.test((el.innerText||'').trim()));
  return {isFollowing:status==='yes'?true:status==='no'?false:null,followingStatus:status,followsYou,relationshipDebug:candidates.slice(0,12)};
}

function findFollowButton(){
  return profileFollowControls().find(el=>followControlState(el)==='no')||null;
}

function findDmButton(){
  const root=document.querySelector('main')||document;
  const preferred=[
    '[data-testid="sendDMFromProfile"]',
    'button[aria-label="Message"]',
    'a[aria-label="Message"]',
    '[role="button"][aria-label="Message"]',
    'button[title="Message"]',
    'a[title="Message"]'
  ];
  for(const sel of preferred){const el=root.querySelector(sel);if(el&&visible(el))return el}
  return [...root.querySelectorAll('button,a,[role="button"]')].filter(visible).find(el=>{
    const t=allText(el); const aria=el.getAttribute?.('aria-label')||''; const id=el.getAttribute?.('data-testid')||'';
    return /^(message|send message)$/i.test(t)||/^message$/i.test(aria)||/(senddmfromprofile|profile.*message|message.*profile)/i.test(id);
  })||null;
}
function dmEligibility(){const dm=findDmButton();return {dmAvailable:dm?true:null,dmStatus:dm?'yes':'unknown',dmReason:dm?'message_button_available':'message_button_not_observed'}}
function collectProfile(){
  const path=location.pathname.split('/').filter(Boolean),handle=path[0]||'';
  return {handle,name:txt('div[data-testid="UserName"] span'),bio:txt('div[data-testid="UserDescription"]'),location:txt('span[data-testid="UserLocation"]'),following:countFrom('following'),followers:countFrom('followers')||countFrom('verified_followers'),joined:[...document.querySelectorAll('span')].map(x=>x.innerText).find(x=>/^Joined\s/i.test(x))||'',url:location.href,...relationship(),...dmEligibility(),collectedAt:new Date().toISOString()};
}

function robustClick(el){
  if(!el) return;
  try{el.scrollIntoView({block:'center',inline:'center'})}catch{}
  // One activation only: dispatching click and then calling click toggled some dialogs twice.
  el.click();
}

function isEditable(el){
  if(!el || el===document.body || el===document.documentElement) return false;
  const tag=(el.tagName||'').toLowerCase();
  const ce=el.getAttribute?.('contenteditable');
  return tag==='textarea' || (tag==='input' && !/^(search|checkbox|radio|button|submit)$/i.test(el.type||'')) || el.isContentEditable || ce==='' || ce==='true' || el.getAttribute?.('role')==='textbox';
}
function deepElements(root=document){
  const out=[];
  const walk=node=>{
    if(!node?.querySelectorAll) return;
    for(const el of node.querySelectorAll('*')){
      out.push(el);
      if(el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}
function composer(){
  const direct=[
    '[data-testid="dmComposerTextInput"]',
    '[data-testid*="composer" i][contenteditable="true"]',
    '[data-testid*="message" i][contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    '[contenteditable="true"]',
    '[role="textbox"][aria-multiline="true"]',
    'textarea[placeholder*="message" i]',
    'textarea[aria-label*="message" i]'
  ];
  for(const sel of direct){
    const matches=[...document.querySelectorAll(sel)].filter(el=>visible(el)&&isDmEditor(el));
    if(matches.length){
      // Prefer editors lower on the page, where X's DM composer normally sits.
      matches.sort((a,b)=>b.getBoundingClientRect().top-a.getBoundingClientRect().top);
      return matches[0];
    }
  }

  // Final fallback, including editors mounted inside open shadow roots.
  const all=deepElements(document).filter(el=>visible(el)&&isDmEditor(el));
  const scored=all.map(el=>{
    const r=el.getBoundingClientRect();
    const meta=[el.getAttribute?.('data-testid')||'',el.getAttribute?.('aria-label')||'',el.getAttribute?.('placeholder')||'',el.getAttribute?.('role')||'',el.className||''].join(' ').toLowerCase();
    let score=0;
    if(/dm|message|composer|textbox|editor/.test(meta)) score+=100;
    if(el.isContentEditable||el.getAttribute?.('contenteditable')==='true') score+=30;
    if(el.getAttribute?.('role')==='textbox') score+=20;
    if(r.top>innerHeight*.45) score+=20;
    if(r.width>180) score+=10;
    return {el,score};
  }).sort((a,b)=>b.score-a.score);
  return scored.find(x=>x.score>=100)?.el||null;
}
function focusedElement(){
  let el=document.activeElement;
  while(el?.shadowRoot?.activeElement) el=el.shadowRoot.activeElement;
  return el;
}
function isDmEditor(el){
  if(!isEditable(el)||el.disabled||el.readOnly||el.getAttribute('aria-disabled')==='true') return false;
  const meta=[el.type,el.getAttribute('data-testid'),el.getAttribute('aria-label'),el.getAttribute('placeholder')].join(' ');
  if(/search|recipient|tweet|post/i.test(meta)) return false;
  return /dmComposer|message|composer/i.test(meta) ||
    ((/^\/(i\/chat|messages)(?:\/|$)/.test(location.pathname)||el.closest('[role="dialog"]')) &&
      (el.isContentEditable||el.tagName==='TEXTAREA'));
}
function closedInboxNotice(handle){
  if(!handle) return null;
  // The recipient-specific notice is sufficient evidence; X varies its dialog actions.
  const controls=[...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const candidates=[...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"], main div, main span'),
    ...deepElements(document).filter(el=>el.matches?.('div,span,p,[role="dialog"],[role="alertdialog"],[role="alert"]'))];
  for(const control of controls){
    for(let scope=control.parentElement;scope && scope!==document.body;scope=scope.parentElement) candidates.push(scope);
  }
  for(const scope of new Set(candidates)){
    if(!visible(scope)||scope.closest?.('article, [data-testid="tweet"], [data-testid="sidebarColumn"]')) continue;
    const text=(scope.innerText||'').replace(/\s+/g,' ').trim();
    const match=text.match(/@([a-z0-9_]+) has a closed inbox\b/i);
    if(!match || normHandle(match[1])!==normHandle(handle)) continue;
    // Avoid interpreting an entire app shell (or quoted post) as a notice.
    if(text.length>600) continue;
    const dismiss=controls.find(el=>scope.contains?.(el) && /^(not now|close|cancel|ok|got it)$/i.test((el.innerText||allText(el)).trim()));
    return {dismiss,text:match[0]+'.',reason:'closed_inbox'};
  }
  return null;
}
function checkClosedInbox(handle){
  // Recheck account notices while waiting for DM controls; X can render them late.
  checkUnusableAccount(handle);
  const notice=closedInboxNotice(handle);
  if(notice) throw Object.assign(new Error(notice.text),{code:'CLOSED_INBOX',notice});
}
async function markDmUnavailable(job,notice){
  const st=await chrome.storage.local.get(['profiles','pendingDmPrepare']);
  const pending=st.pendingDmPrepare;
  if(!pending || normHandle(pending.handle)!==normHandle(job.handle) || pending.startedAt!==job.startedAt) return {ok:false,error:'The preparation job changed.'};
  const profiles=st.profiles||{},key=normHandle(job.handle),now=new Date().toISOString();
  profiles[key]={...(profiles[key]||{}),handle:job.handle,draft:job.draft,
    processingStatus:'dm_unavailable',dmAvailable:false,dmStatus:'no',dmReason:'closed_inbox',
    dmUnavailableAt:now,dmEvidence:notice.text,alternativeOutreachNeeded:true,lastUpdated:now};
  // Dismiss only Not Now. Never enter the X Number flow.
  if(notice.dismiss?.isConnected){try{robustClick(notice.dismiss)}catch{/* Queue navigation will close the notice. */}}
  await persistProcessedProfile(profiles[key]);
  await chrome.storage.local.set({profiles,pendingDmPrepare:{...pending,stage:'dm_unavailable',dmReason:'closed_inbox',updatedAt:now}});
  await appendPersistentLog('DM UNAVAILABLE: CLOSED INBOX',{handle:key,reason:'closed_inbox'});
  return {ok:true,unavailable:true,reason:'closed_inbox'};
}
async function waitForComposer(ms=90000,handle){
  const end=Date.now()+ms;
  let previous=null,stableSince=0,lastReport=0;
  while(Date.now()<end){
    checkClosedInbox(handle);
    const box=composer();
    if(Date.now()-lastReport>=10000){
      lastReport=Date.now();
      await appendPersistentLog('WAITING FOR COMPOSER',{handle,remainingMs:Math.max(0,end-Date.now()),found:!!box,focused:!!box&&(focusedElement()===box||box.contains(focusedElement())),url:location.href});
    }
    if(box!==previous){previous=box;stableSince=Date.now()}
    if(box && Date.now()-stableSince>=800){
      box.focus();
      await sleep(200);
      if(box.isConnected && composer()===box && (focusedElement()===box||box.contains(focusedElement()))) return box;
    }
    await sleep(200);
  }
  return null;
}
async function fillComposer(text,handle){
  for(let attempt=0;attempt<3;attempt++){
    const box=await waitForComposer(attempt===0?90000:10000,handle);
    if(!box){await appendPersistentLog('COMPOSER ATTEMPT FAILED',{attempt:attempt+1,handle,reason:'No stable focused editor'});continue;}
    if(readComposer(box)!==text.trim()) await insertIntoComposer(box,text);
    // Let the editor's own state update and survive a render before declaring success.
    await sleep(1200);
    if(box.isConnected && composer()===box && readComposer(box)===text.trim()){
      checkClosedInbox(handle);
      return box;
    }
  }
  throw new Error('The DM text box did not retain the draft. Preparation has not completed.');
}
function readComposer(box){
  return String(('value' in box ? box.value : (box.innerText||box.textContent||''))||'').trim();
}
async function insertIntoComposer(box,text){
  box.focus();
  const tag=(box.tagName||'').toLowerCase();
  if(tag==='textarea'||tag==='input'){
    const proto=tag==='textarea'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
    if(setter) setter.call(box,text); else box.value=text;
    box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    box.dispatchEvent(new Event('change',{bubbles:true}));
    return;
  }

  // Give X's Lexical editor one paste operation. Do not also mutate textContent
  // or dispatch input/change: X can reconcile those as a second insertion.
  // This does not read or overwrite the user's system clipboard.
  const transfer=new DataTransfer();
  transfer.setData('text/plain',text);
  try{
    const selection=window.getSelection();
    const range=document.createRange();
    range.selectNodeContents(box);
    selection.removeAllRanges();
    selection.addRange(range);
  }catch{}
  box.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
}
function findSendButton(box=composer()){
  const isSend=el=>{
    const id=el.getAttribute('data-testid')||'';
    const labels=['aria-label','title','data-tooltip-content'].map(k=>el.getAttribute(k)||'');
    labels.push((el.innerText||'').trim());
    return /^(dmComposerSendButton|(?:dm|chat)[-_](?:composer[-_])?send(?:[-_]message)?[-_]button)$/i.test(id) ||
      labels.some(label=>/^send(?: message)?(?:\s*\([^)]*\))?$/i.test(label.trim()));
  };
  // Prefer the controls beside this editor, including open shadow roots.
  for(let scope=box?.parentElement,depth=0;scope&&scope!==document.body&&depth<5;scope=scope.parentElement,depth++){
    const buttons=[...scope.querySelectorAll('button,[role="button"]')].filter(visible);
    const named=buttons.filter(isSend);
    if(named.length===1) return named[0];
    // Some versions render only an arrow on the composer's form submit button.
    if(scope.tagName==='FORM'){
      const submit=buttons.filter(el=>el.type==='submit');
      if(submit.length===1) return submit[0];
    }
  }
  const matches=deepElements(document).filter(el=>el.matches?.('button,[role="button"]')&&visible(el)&&isSend(el));
  return matches.length===1?matches[0]:null;
}

async function awaitPreparedForApproval(expected){
  const initial=(await chrome.storage.local.get('pendingDmPrepare')).pendingDmPrepare;
  if(normHandle(initial?.handle)!==expected) throw new Error('The prepared recipient does not match this approval.');
  if(initial.stage!=='prepared' && !preparing) void autoPreparePendingDm();
  const end=Date.now()+210000;
  do{
    const pending=(await chrome.storage.local.get('pendingDmPrepare')).pendingDmPrepare;
    if(normHandle(pending?.handle)!==expected || pending.startedAt!==initial.startedAt) throw new Error('The preparation job changed. Review the new recipient before sending.');
    checkClosedInbox(expected);
    if(pending.stage==='dm_unavailable') throw Object.assign(new Error('Closed inbox'),{code:'CLOSED_INBOX',notice:{text:'@'+pending.handle+' has a closed inbox.'}});
    if(pending.stage==='prepared') return pending;
    if(!['open_profile','profile_loaded','profile_message_clicked','chat_loaded'].includes(pending.stage)) throw new Error(`DM preparation is ${pending.stage}: ${pending.error||'prepare this recipient before sending.'}`);
    await sleep(200);
  }while(Date.now()<end);
  throw new Error('The draft is still being prepared. Wait for DM ready, then approve again. Nothing was sent.');
}


async function waitForApprovedSend(pending,text,ms=60000){
  const end=Date.now()+ms;
  do{
    const live=(await chrome.storage.local.get('pendingDmPrepare')).pendingDmPrepare;
    if(!live || live.startedAt!==pending.startedAt || normHandle(live.handle)!==normHandle(pending.handle) || live.stage!=='prepared')
      throw new Error('The preparation job changed. Review the recipient before sending.');
    if(location.href!==pending.preparedUrl) throw new Error('The conversation changed. Prepare this recipient again before sending.');
    checkClosedInbox(pending.handle);
    // X may replace the editor and controls while its conversation UI loads.
    const box=composer();
    if(box){
      const draft=readComposer(box);
      if(draft && draft!==text) throw new Error('The DM text differs from the reviewed draft. Prepare DM again to sync your edits.');
      const button=findSendButton(box);
      if(draft===text && button && !button.disabled && button.getAttribute('aria-disabled')!=='true') return {box,button};
    }
    await sleep(200);
  }while(Date.now()<end);
  throw new Error('X did not make the reviewed draft and enabled Send button ready within 60 seconds. Nothing was sent.');
}


function domDebug(){return {url:location.href,readyState:document.readyState,composer:!!composer(),sendButton:!!findSendButton(),buttons:[...document.querySelectorAll('button')].filter(visible).slice(-35).map(allText).filter(Boolean)}}

function findNewChatButton(){
  // Current X Chat UI: center/right empty-conversation panel. This is the exact
  // control X exposes for the large "New chat" button and is intentionally
  // checked before any text-based fallbacks so the three-panel layout is irrelevant.
  const exactTestId=document.querySelector('button[data-testid="dm-empty-conversation-new-chat-button"]');
  if(exactTestId&&visible(exactTestId)) return exactTestId;

  // Some X builds wrap the same control with role=button or move attributes.
  const testIdFallback=[...document.querySelectorAll('[data-testid="dm-empty-conversation-new-chat-button"]')].find(visible);
  if(testIdFallback) return testIdFallback;

  const all=[...document.querySelectorAll('button,[role="button"],a')].filter(visible);
  const exact=all.find(el=>/^new chat$/i.test(allText(el)));
  if(exact)return exact;
  const exactMsg=all.find(el=>/^new message$/i.test(allText(el)));
  if(exactMsg)return exactMsg;
  const labelled=all.find(el=>/(new chat|new message|start.*conversation|compose.*message)/i.test([allText(el),el.getAttribute('aria-label')||'',el.getAttribute('title')||'',el.getAttribute('data-testid')||''].join(' ')));
  if(labelled)return labelled;
  return null;
}

async function waitForElement(getter,ms=20000){
  const end=Date.now()+ms;
  do{
    const value=getter();
    if(value) return value;
    await sleep(200);
  }while(Date.now()<end);
  return null;
}

function recipientDialog(){
  const dialogs=[...document.querySelectorAll('[role="dialog"], [data-testid*="sheet" i], [data-testid*="dialog" i]')].filter(visible);
  return dialogs.find(d=>[...d.querySelectorAll('input')].some(visible))||dialogs[0]||null;
}
function recipientSearchInput(){
  const dialog=recipientDialog();
  if(dialog){
    const inputs=[...dialog.querySelectorAll('input')].filter(visible);
    if(inputs.length) return inputs.find(el=>/search|people|name|username/i.test([el.placeholder,el.getAttribute('aria-label'),el.getAttribute('data-testid')].filter(Boolean).join(' ')))||inputs[0];
  }
  const inputs=[...document.querySelectorAll('input')].filter(visible);
  return inputs.find(el=>/people|username|recipient|new message/i.test([el.placeholder,el.getAttribute('aria-label'),el.getAttribute('data-testid')].filter(Boolean).join(' ')))||null;
}
function setNativeInput(el,value){
  el.focus();
  const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
  if(setter)setter.call(el,value);else el.value=value;
  el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
}
function exactRecipientCandidate(handle){
  const want=normHandle(handle), scope=recipientDialog()||document;
  const all=[...scope.querySelectorAll('[data-testid="TypeaheadUser"], [role="option"], [role="listitem"], button, a, div')].filter(visible);
  return all.find(el=>{
    const t=(el.innerText||'').toLowerCase();
    const href=(el.getAttribute?.('href')||'').toLowerCase();
    return t.includes('@'+want)||href===('/'+want)||href.startsWith('/'+want+'?');
  })||null;
}
function nextRecipientButton(){
  const scope=recipientDialog()||document;
  return [...scope.querySelectorAll('button,[role="button"]')].filter(visible).find(el=>/^(next|done|start|chat)$/i.test(allText(el))||/next/i.test(el.getAttribute('data-testid')||''))||null;
}
function chatDebug(){return {url:location.href,readyState:document.readyState,dialog:!!recipientDialog(),composer:!!composer(),inputs:[...document.querySelectorAll('input,textarea')].filter(visible).map(el=>({placeholder:el.placeholder||'',aria:el.getAttribute('aria-label')||'',testid:el.getAttribute('data-testid')||''})).slice(0,20),controls:[...document.querySelectorAll('button,[role="button"],a')].filter(visible).map(el=>({text:allText(el).slice(0,100),aria:el.getAttribute('aria-label')||'',title:el.getAttribute('title')||'',testid:el.getAttribute('data-testid')||'',href:el.getAttribute('href')||''})).filter(x=>x.text||x.aria||x.title).slice(0,70)}}

let contentLogQueue=Promise.resolve();
function appendPersistentLog(label,data){
  // Diagnostics must never reject into the workflow or the rejection logger.
  contentLogQueue=contentLogQueue.then(()=>writePersistentLog(label,data)).catch(()=>{});
  return contentLogQueue;
}
async function writePersistentLog(label,data){
  const st=await chrome.storage.local.get(['contentDebugLog']);
  let log=typeof st.contentDebugLog==='string'?st.contentDebugLog:'';
  const line=`[${new Date().toLocaleTimeString()}] ${label}${data!==undefined?' :: '+JSON.stringify(data,null,2):''}\n`;
  log=(log+line).slice(-60000);
  await chrome.storage.local.set({contentDebugLog:log});
}
async function updatePendingDm(patch,job){
  const st=await chrome.storage.local.get(['pendingDmPrepare']);
  const cur=st.pendingDmPrepare||{};
  if(job && (cur.startedAt!==job.startedAt || normHandle(cur.handle)!==normHandle(job.handle))) return;
  await chrome.storage.local.set({pendingDmPrepare:{...cur,...patch,updatedAt:new Date().toISOString()}});
  if(patch.stage && patch.stage!==cur.stage) await appendPersistentLog('DM STAGE',{handle:cur.handle,from:cur.stage,to:patch.stage,url:location.href,error:patch.error});
}

async function ensureFollowingOnPage(handle,engagementJob){
  const settings=await chrome.storage.local.get(null);
  if(reviewMode(settings)){if(!engagementJob) throw new Error("Start the engagement queue to follow in this mode.");await engagementGuard(engagementJob);}
  // Sample the live recipient after the storage await, before the single Follow click.
  const profile=collectProfile();
  if(normHandle(profile.handle)!==normHandle(handle)) throw new Error('Profile changed before audience review.');
  const review=audienceReview(settings,profile);
  if(!review.eligible) throw new Error(review.reason);
  let rel=relationship();
  // The header can settle before its action controls mount. Wait without clicking twice.
  if(rel.followingStatus==='unknown'){
    rel=await waitForElement(()=>{
      if(normHandle(location.pathname.split('/')[1])!==normHandle(handle)) throw new Error('Profile changed while waiting for Follow.');
      const live=relationship();
      return live.followingStatus!=='unknown'?live:null;
    },5000);
    if(!rel) return {ok:false,error:'The profile Follow control did not appear. Check the X profile and retry.',debug:domDebug()};
    // Recheck current settings and profile after waiting for late controls.
    const liveSettings=await chrome.storage.local.get(null);
    if(reviewMode(liveSettings)){if(!engagementJob) throw new Error('Start the engagement queue to follow in this mode.');await engagementGuard(engagementJob);}
    const liveProfile=collectProfile();
    if(normHandle(liveProfile.handle)!==normHandle(handle)) throw new Error('Profile changed while waiting for Follow.');
    const liveReview=audienceReview(liveSettings,liveProfile);
    if(!liveReview.eligible) throw new Error(liveReview.reason);
    rel=relationship();
    if(rel.followingStatus==='unknown') return {ok:false,error:'The profile Follow control disappeared. Check the X profile and retry.',debug:domDebug()};
  }
  if(rel.followingStatus==='yes') return {ok:true,alreadyFollowing:true,followedNow:false,relationship:rel,debug:domDebug()};
  const btn=findFollowButton();
  if(!btn) return {ok:false,error:'X reports not-following, but the Follow button could not be located.',relationship:rel,debug:domDebug()};
  if(engagementJob) await engagementGuard(engagementJob);
  robustClick(btn);
  const end=Date.now()+9000;
  while(Date.now()<end){
    await sleep(300);
    if(engagementJob && normHandle(collectProfile().handle)!==normHandle(handle)) throw new Error('Profile changed before follow confirmation.');
    rel=relationship();
    if(rel.followingStatus==='yes') return {ok:true,alreadyFollowing:false,followedNow:true,relationship:rel,debug:domDebug()};
  }
  // A dispatched click is not proof that X accepted the follow.
  return {ok:false,error:'Follow was clicked, but X did not confirm Following. Check the profile before retrying.',uncertain:true,relationship:relationship(),debug:domDebug()};
}

async function markPrepared(job, box){
  box=await fillComposer(job.draft,job.handle);
  checkClosedInbox(job.handle);
  const inserted=readComposer(box);
  if(!inserted) throw new Error('DM composer opened, but the saved draft could not be inserted.');
  const st=await chrome.storage.local.get(['profiles','pendingDmPrepare']);
  const live=st.pendingDmPrepare;
  if(!live || normHandle(live.handle)!==normHandle(job.handle) || live.startedAt!==job.startedAt || ['sending','sent','dm_unavailable','account_suspended','account_not_found'].includes(live.stage)) return {ok:true,superseded:true};
  const profiles=st.profiles||{}; const key=normHandle(job.handle);
  profiles[key]={...(profiles[key]||{}),draft:job.draft,processingStatus:'prepared',preparedAt:new Date().toISOString(),lastUpdated:new Date().toISOString()};
  await chrome.storage.local.set({profiles,currentDraft:job.draft,pendingDmPrepare:{...job,stage:'prepared',preparedUrl:location.href,preparedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}});
  await appendPersistentLog('PROFILE DM PREPARE: READY',{handle:key,insertedPreview:inserted.slice(0,180),debug:domDebug()});
  return {ok:true,prepared:true,debug:domDebug()};
}

async function prepareDmFromProfile(job){
  const handle=normHandle(job.handle);
  const pathHandle=normHandle(location.pathname.split('/').filter(Boolean)[0]||'');
  if(pathHandle!==handle) return {ok:false,error:`Current page is not @${handle}'s profile.`,debug:domDebug()};

  await updatePendingDm({stage:'profile_loaded',profileUrl:location.href},job);
  await appendPersistentLog('PROFILE DM PREPARE: PROFILE LOADED',{handle,url:location.href,debug:domDebug()});

  let reportedAt=0;
  const dm=await waitForElement(()=>{
    checkClosedInbox(handle);
    const b=findDmButton();
    if(Date.now()-reportedAt>=10000){reportedAt=Date.now();void appendPersistentLog('WAITING FOR MESSAGE BUTTON',{handle,found:!!b,disabled:b?.disabled,url:location.href,readyState:document.readyState});}
    return b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true'?b:null;
  },90000);
  if(!dm){
    const dbg={...domDebug(),profileHandle:pathHandle,mainButtons:[...(document.querySelector('main')||document).querySelectorAll('button,a,[role="button"]')].filter(visible).map(el=>({text:allText(el).slice(0,100),aria:el.getAttribute('aria-label')||'',testid:el.getAttribute('data-testid')||'',href:el.getAttribute('href')||''})).slice(0,60)};
    throw Object.assign(new Error(`Could not find the Message button on @${handle}'s profile.`),{debug:dbg});
  }

  await appendPersistentLog('PROFILE DM PREPARE: MESSAGE BUTTON FOUND',{handle,text:allText(dm),aria:dm.getAttribute('aria-label')||'',testid:dm.getAttribute('data-testid')||'',href:dm.getAttribute('href')||'',outerHTML:(dm.outerHTML||'').slice(0,1200)});
  await updatePendingDm({stage:'profile_message_clicked'},job);
  robustClick(dm);

  // If X opens the composer as an SPA/modal, finish in this same content script.
  const box=await waitForComposer(90000,job.handle);
  if(box) return await markPrepared({...job,stage:'profile_message_clicked'},box);

  // If X performed a full navigation, this content-script instance may be replaced.
  // The next instance will resume from chrome.storage.local using the pending stage.
  throw new Error('The direct DM text box did not become ready within 90 seconds. Keep the X tab visible and check the page diagnostics.');
}

let preparing=false;
let sending=false;
async function runPrepare(job){
  await assertReviewDmAllowed(job.handle);
  if(preparing) return {ok:true,navigating:true};
  preparing=true;
  try{return await prepareDmFromProfile(job)}catch(e){
    if(e.code==='ACCOUNT_UNUSABLE') return await markUnusableAccount(job,e.message,e.processingStatus);
    if(e.code==='CLOSED_INBOX') return await markDmUnavailable(job,e.notice);
    throw e;
  }finally{preparing=false}
}
async function autoPreparePendingDm(){
  let job;
  if(preparing||sending) return;
  preparing=true;
  try{
  const st=await chrome.storage.local.get(['pendingDmPrepare']);
  job=st.pendingDmPrepare;
  if(!job?.handle||!job?.draft||!['open_profile','profile_loaded','profile_message_clicked','chat_loaded','prepared','failed'].includes(job.stage)) return;
  await assertReviewDmAllowed(job.handle);
  const identity=await chrome.runtime.sendMessage({type:'TAB_ID'});
  if(job.tabId && identity?.tabId!==job.tabId) return;
  checkClosedInbox(job.handle);
  if(['prepared','failed'].includes(job.stage)) return;
  const handle=normHandle(job.handle);
    const pathHandle=normHandle(location.pathname.split('/').filter(Boolean)[0]||'');
    const onTargetProfile=pathHandle===handle && !location.pathname.startsWith('/i/');
    const onChat=/^\/(i\/chat|messages)(?:\/|$)/.test(location.pathname);

    if(onTargetProfile && ['open_profile','profile_loaded'].includes(job.stage||'open_profile')){
      await prepareDmFromProfile(job);
      return;
    }

    if(onChat && ['profile_message_clicked','chat_loaded'].includes(job.stage)){
      preparing=true;
      await updatePendingDm({stage:'chat_loaded'},job);
      await appendPersistentLog('PROFILE DM PREPARE: DIRECT CHAT LOADED',{handle,url:location.href,debug:domDebug()});
      const box=await waitForComposer(90000,job.handle);
      if(!box) throw new Error(`Direct conversation for @${handle} opened, but the DM composer did not appear.`);
      await markPrepared({...job,stage:'chat_loaded'},box);
    }
  }catch(e){
    if(e.code==='ACCOUNT_UNUSABLE'){await markUnusableAccount(job,e.message,e.processingStatus);return}
    if(e.code==='CLOSED_INBOX'){await markDmUnavailable(job,e.notice);return}
    const debug=e?.debug||chatDebug();
    if(job) await updatePendingDm({stage:'failed',error:e.message},job);
    await appendPersistentLog('PROFILE DM PREPARE FAILED',{error:e.message,debug});
  }finally{preparing=false}
}


function accountNotice(pattern){
  const root=document.querySelector('[data-testid="primaryColumn"]')||document.querySelector('main');
  if(!root) return '';
  // X also renders this notice as plain nested divs/spans without heading test IDs.
  // Match the entire visible element text, excluding posts and sidebar content.
  const notice=[...root.querySelectorAll('div, span, h1, h2, p')]
    .find(el=>!el.closest?.('article, [data-testid="tweet"], [data-testid="sidebarColumn"], [role="dialog"]') &&
      visible(el) && pattern.test((el.innerText||'').replace(/\s+/g,' ').trim()));
  return notice?(notice.innerText||'').replace(/\s+/g,' ').trim():'';
}

function missingAccountNotice(){return accountNotice(/^this account doesn[’']t exist[.!]?$/i)}
function suspendedAccountNotice(handle){
  if(!handle || location.pathname.replace(/\/$/,'').toLowerCase()!=='/'+normHandle(handle)) return '';
  return accountNotice(/^account suspended[.!]?$/i);
}
function checkUnusableAccount(handle){
  // Bind the notice to the requested profile so another SPA route cannot mark this recipient.
  if(!handle || location.pathname.replace(/\/$/,'').toLowerCase()!=='/'+normHandle(handle)) return;
  const suspended=suspendedAccountNotice(handle),reason=suspended||missingAccountNotice();
  if(reason) throw Object.assign(new Error(reason),{code:'ACCOUNT_UNUSABLE',processingStatus:suspended?'account_suspended':'account_not_found'});
}
async function markUnusableAccount(job,reason,processingStatus){
  // Ignore a late result from a job that the queue has already replaced.
  const {pendingDmPrepare:pending}=await chrome.storage.local.get('pendingDmPrepare');
  if(!pending || pending.startedAt!==job.startedAt || normHandle(pending.handle)!==normHandle(job.handle)) return {ok:false,error:'The preparation job changed.'};
  const profiles=await readProfiles(),key=normHandle(job.handle),now=new Date().toISOString();
  const suspended=processingStatus==='account_suspended';
  profiles[key]={...profiles[key],handle:job.handle,processingStatus,
    [suspended?'accountSuspendedAt':'accountNotFoundAt']:now,eligibilityReason:reason,visited:true,lastUpdated:now};
  // Persist the terminal record before completing the job, even if the panel is closed.
  await persistProcessedProfile(profiles[key]);
  await chrome.storage.local.set({profiles});
  await updatePendingDm({stage:processingStatus,error:reason},job);
  await appendPersistentLog('ACCOUNT UNUSABLE; MOVING TO NEXT PROFILE',{handle:key,reason,processingStatus});
  return {ok:true,unavailable:true,[suspended?'accountSuspended':'accountNotFound']:true,reason};
}

let readinessSample={};
function profileReadiness(handle){
  const path=location.pathname.replace(/\/$/,'');
  const name=txt('[data-testid="UserName"]');
  const sameProfile=path.toLowerCase()==='/'+normHandle(handle);
  // Explicit account notices take precedence over a header left behind during hydration.
  const suspended=suspendedAccountNotice(handle);
  if(suspended) return {ok:false,accountSuspended:true,handle:normHandle(handle),version:CONTENT_BUILD,reason:suspended};
  const notice=sameProfile && missingAccountNotice();
  if(notice) return {ok:false,accountNotFound:true,handle:normHandle(handle),version:CONTENT_BUILD,reason:notice};
  const signature=JSON.stringify([path,name,txt('[data-testid="UserDescription"]'),countFrom('following'),countFrom('followers'),txt('span[data-testid="UserLocation"]')]);
  if(signature!==readinessSample.signature) readinessSample={signature,since:Date.now()};
  const ok=sameProfile && !!name && document.readyState!=='loading' && Date.now()-readinessSample.since>=1500;
  return {ok,version:CONTENT_BUILD,reason:!sameProfile?'The target profile route is not open':!name?'Waiting for profile header':!ok?'Waiting for profile data to settle':'ready',debug:{url:location.href,readyState:document.readyState,hasName:!!name,stableMs:Date.now()-readinessSample.since}};
}

async function checkAutomaticSend(){
  const st=await chrome.storage.local.get(['autoSend','runState']);
  if(st.autoSend!==true || st.runState!=='running') throw new Error('Automatic send cancelled: queue paused, stopped, or automatic sending disabled.');
}

chrome.runtime.onMessage.addListener((msg,sender,send)=>{
  if(msg.type==='PING'){send({ok:true,version:CONTENT_BUILD,url:location.href,title:document.title,debug:domDebug()});return true}
  if(msg.type==='PROFILE_READY'){send(profileReadiness(msg.handle));return true}
  if(msg.type==='COLLECT_PROFILE'){
    (async()=>{try{
      const handle=msg.handle||normHandle(location.pathname.split('/')[1]);
      const ready=await waitForElement(()=>{
        const result=profileReadiness(handle);
        return result.ok||result.accountNotFound||result.accountSuspended?result:null;
      },120000);
      if(ready?.accountNotFound||ready?.accountSuspended){send(ready);return}
      if(!ready) throw new Error(`Profile @${handle} did not stabilize within 120 seconds.`);
      const profile=collectProfile();send({ok:true,version:CONTENT_BUILD,profile,debug:{...domDebug(),relationship:profile.relationshipDebug,dmStatus:profile.dmStatus}});
    }catch(e){await appendPersistentLog('COLLECTION FAILED',{error:e.message,url:location.href});send({ok:false,error:e.message})}})();
    return true;
  }
  if(msg.type==='ENSURE_FOLLOWING'){
    (async()=>{try{send(await ensureFollowingOnPage(msg.handle))}catch(e){send({ok:false,error:e.message,debug:domDebug()})}})();
    return true;
  }
  if(msg.type==='PREPARE_FROM_PROFILE'){
    // Acknowledge immediately. Progress/results live in storage across page navigation.
    let acknowledged=false;
    (async()=>{let job;try{
      job=(await chrome.storage.local.get('pendingDmPrepare')).pendingDmPrepare;
      const identity=await chrome.runtime.sendMessage({type:'TAB_ID'});
      if(!job || normHandle(job.handle)!==normHandle(msg.handle) || job.draft!==msg.draft || (job.tabId && identity?.tabId!==job.tabId)){
        send({ok:false,error:'Preparation job or tab does not match. Click Prepare DM again.',version:CONTENT_BUILD});return;
      }
      send({ok:true,accepted:true,version:CONTENT_BUILD});acknowledged=true;
      await appendPersistentLog('PREPARE REQUEST ACCEPTED',{handle:job.handle,tabId:identity?.tabId,build:CONTENT_BUILD,url:location.href});
      if(['open_profile','profile_loaded'].includes(job.stage)) await runPrepare(job);
      else await autoPreparePendingDm();
    }catch(e){if(!acknowledged)send({ok:false,error:e.message,version:CONTENT_BUILD});if(job)await updatePendingDm({stage:'failed',error:e.message},job);await appendPersistentLog('PROFILE DM PREPARE FAILED',{error:e.message,stack:e.stack,debug:e?.debug||domDebug()})}})();
    return true;
  }
  if(msg.type==='FILL_DM'){
    (async()=>{try{const box=await fillComposer(msg.text||'');send({ok:true,debug:{...domDebug(),insertedPreview:readComposer(box).slice(0,160)}})}catch(e){send({ok:false,error:e.message,debug:domDebug()})}})();
    return true;
  }
  if(msg.type==='APPROVE_SEND'){
    if(sending){send({ok:false,error:'A send approval is already in progress.'});return true}
    sending=true;
    (async()=>{let approvalJob;try{
      await assertReviewDmAllowed(msg.expectedHandle,!!msg.automatic);
      if(msg.automatic) await checkAutomaticSend();
      approvalJob=(await chrome.storage.local.get('pendingDmPrepare')).pendingDmPrepare;
      const expected=normHandle(msg.expectedHandle);
      const savedRecipient=(await readProfiles())[expected];
      if(savedRecipient?.processingStatus==='account_not_found') throw new Error('This recipient is saved as account_not_found. No message was sent.');
      if(savedRecipient?.processingStatus==='account_suspended') throw new Error('This recipient is saved as suspended. No message was sent.');
      if(savedRecipient?.processingStatus==='contacted') throw new Error('This recipient is already saved as contacted. No message was sent.');
      const pending=await awaitPreparedForApproval(expected);
      if(expected && normHandle(pending?.handle)!==expected){send({ok:false,error:`Recipient verification failed. Prepared recipient is @${pending?.handle||'unknown'}, expected @${expected}.`,debug:domDebug()});return}
      if(pending?.stage!=='prepared'){send({ok:false,error:`DM preparation stage is ${pending?.stage||'none'}, not prepared.`,debug:domDebug()});return}
      if(pending.preparedUrl!==location.href) throw new Error('The conversation changed. Prepare this recipient again before sending.');
      const box=await waitForComposer(5000,pending.handle);
      if(!box){send({ok:false,error:'DM composer is not open on the current X chat page. Use Prepare DM first.',debug:domDebug()});return}
      if(!readComposer(box)) throw new Error('The DM text box is empty. Prepare DM again before approving.');
      if(readComposer(box)!==String(msg.expectedDraft||pending.draft).trim()) throw new Error('The DM text differs from the reviewed draft. Prepare DM again to sync your edits.');
      const reviewedDraft=String(msg.expectedDraft||pending.draft).trim();
      const {box:readyBox,button:btn}=await waitForApprovedSend(pending,reviewedDraft);
      await assertReviewDmAllowed(msg.expectedHandle,!!msg.automatic);
      if(msg.automatic) await checkAutomaticSend();
      await updatePendingDm({stage:'sending'},pending);
      await assertReviewDmAllowed(msg.expectedHandle,!!msg.automatic);
      if(msg.automatic) await checkAutomaticSend();
      // Recheck after the storage await, immediately before the one allowed click.
      if(location.href!==pending.preparedUrl || composer()!==readyBox || readComposer(readyBox)!==reviewedDraft ||
        findSendButton(readyBox)!==btn || btn.disabled || btn.getAttribute('aria-disabled')==='true'){
        await updatePendingDm({stage:'prepared'},pending);
        throw new Error('The conversation UI changed before Send. Wait for it to settle and approve again. Nothing was sent.');
      }
      robustClick(btn);
      const cleared=await waitForElement(()=>{checkClosedInbox(pending.handle);const live=composer();return live&&!readComposer(live)},15000);
      if(!cleared) throw new Error('Send was clicked but X did not clear the draft. Check the conversation before retrying; the message may have been sent.');
      // Save the durable result here, before acknowledging the send to the panel.
      // The panel may already have closed or been reloaded.
      const records=await readProfiles(),now=new Date().toISOString();
      await persistProcessedProfile({...records[normHandle(pending.handle)],handle:pending.handle,
        processingStatus:'contacted',contacted:true,contactedAt:now,draft:reviewedDraft,lastUpdated:now});
      await updatePendingDm({stage:'sent'},pending);
      send({ok:true,debug:{...domDebug(),buttonText:allText(btn)}});
    }catch(e){
      if(e.code==='ACCOUNT_UNUSABLE' && approvalJob){send(await markUnusableAccount(approvalJob,e.message,e.processingStatus));return}
      if(e.code==='CLOSED_INBOX' && approvalJob){send(await markDmUnavailable(approvalJob,e.notice));return}
      send({ok:false,error:e.message,debug:domDebug()});
    }finally{sending=false}})();
    return true;
  }
  return false;
});

// Continue pending prepare jobs after full navigation / popup closure.
async function resumePendingDmSafely(){
  // Reloading the extension disconnects scripts in existing tabs.
  if(!chrome.runtime?.id){
    stopContentWork();
    return;
  }
  try{await autoPreparePendingDm()}
  catch(e){
    if(extensionContextInvalidated(e)){stopContentWork();return}
    await appendPersistentLog('DM RESUME FAILED',{error:e?.message||String(e)})
  }
}
prepareStartupTimer=setTimeout(resumePendingDmSafely,900);
// Resume even when an SPA route finishes changing well after content-script startup.
prepareResumeTimer=setInterval(resumePendingDmSafely,2000);

void appendPersistentLog('CONTENT SCRIPT READY',{build:CONTENT_BUILD,url:location.href,readyState:document.readyState}).catch(()=>{});
window.addEventListener('error',e=>{void appendPersistentLog('CONTENT ERROR',{message:e.message,file:e.filename,line:e.lineno}).catch(()=>{})});
window.addEventListener('unhandledrejection',e=>{
  // Chrome rejects APIs already awaited by the old script when an extension
  // reload replaces it. Stop that dead instance and consume this lifecycle error.
  if(extensionContextInvalidated(e.reason)){stopContentWork();e.preventDefault();return}
  void appendPersistentLog('CONTENT REJECTION',{error:e.reason?.stack||String(e.reason)}).catch(()=>{});
});
