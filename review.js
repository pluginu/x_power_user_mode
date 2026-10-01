// Review controls never click engagement actions on X.
async function reviewSettings(){await uiReady;return await chrome.storage.local.get(null)}
async function openReviewProfile(handle){
  const s=await reviewSettings();
  handle=profileKey(handle);
  if(!parseHandles(s.handles).some(h=>profileKey(h)===handle)) throw new Error('Choose a handle from your Profiles list.');
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id) throw new Error('Open an X tab first.');
  // Clear the previous automated job before navigation so manual review cannot resume a stale draft.
  await chrome.storage.local.set({runState:'paused',autoSend:false,pendingDmPrepare:null,workflowStep:null,
    workflowCurrent:null,currentDraft:'',reviewHandle:handle,workflowTabId:tab.id});
  current=null;$('message').value='';$('profile').textContent='Open profile for manual review.';
  $('reviewHandle').value=handle;
  await chrome.tabs.update(tab.id,{url:'https://x.com/'+encodeURIComponent(handle)});
  status(`Review @${handle} on X. Record only interactions you complete yourself.`);
  await renderReview();
}
async function nextReview(){
  const s=await reviewSettings();
  const q=parseHandles(s.handles).map(profileKey);
  const profiles=await db();
  const available=q.filter(h=>!['account_suspended','account_not_found','contacted'].includes(profiles[h]?.processingStatus)&&
    !(s[ENGAGEMENT_PREFIX+h]||[]).some(e=>e.type==='follow'));
  if(!available.length){status('Follow review complete. All available profiles have a recorded follow. Staged eligibility appears below.');return}
  const index=q.indexOf(profileKey(s.reviewHandle));
  const handle=available.find(h=>q.indexOf(h)>index)||available[0];
  await openReviewProfile(handle);
}
function reviewAction(fn){return async()=>{try{await fn()}catch(e){status(e.message)}}}
async function recordEngagement(type){
  const s=await reviewSettings(),handle=profileKey($('reviewHandle').value);
  if(!parseHandles(s.handles).some(h=>profileKey(h)===handle)) throw new Error('Enter a handle from your Profiles list.');
  let post='';
  if(type!=='follow'){
    let u;try{u=new URL($('engagementPost').value.trim())}catch{throw new Error('Enter the X post URL you interacted with.')}
    const m=u.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)\/?$/);
    if(u.protocol!=='https:'||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname)||!m||profileKey(m[1])!==handle) throw new Error('Use a post URL belonging to the selected handle.');
    post='https://x.com/'+handle+'/status/'+m[2];
  }
  const key=ENGAGEMENT_PREFIX+handle,events=s[key]||[];
  if(events.some(e=>e.type===type&&e.post===post)) throw new Error('This interaction is already recorded.');
  await chrome.storage.local.set({[key]:[...events,{type,post,at:Date.now()}],reviewHandle:handle});
  status(`Recorded your ${type} for @${handle}.`);
  await renderReview();
}
async function renderReview(){
  const s=await reviewSettings();
  const selected=profileKey($('reviewHandle').value||s.reviewHandle);
  const summary=(h)=>{
    const r=engagementEligibility(s,s[ENGAGEMENT_PREFIX+h]||[]);
    const wait=r.eligibleAt===null?'No interactions recorded':Date.now()<r.eligibleAt?'Wait until '+new Date(r.eligibleAt).toLocaleString():'Waiting period complete';
    return `@${h}: ${r.likes} likes, ${r.comments} comments, ${r.followed?'follow recorded':'follow needed'}. ${wait}. ${r.eligible?'Eligible for DM review':'Requirements incomplete'}.`;
  };
  $('engagementStatus').textContent=selected?summary(selected):'Select a profile to record completed interactions.';
  const container=$('reviewQueue');container.replaceChildren();
  if(!reviewMode(s)) return;
  const profiles=await db();
  for(const h of parseHandles(s.handles).map(profileKey)){
    const row=document.createElement('p');row.className='sub';
    const button=document.createElement('button');button.textContent='Review @'+h;
    button.onclick=reviewAction(()=>openReviewProfile(h));
    const detail=document.createElement('span');
    detail.textContent=' '+summary(h)+(isProcessed(profiles[h])?' Saved status: '+profiles[h].processingStatus:'');
    row.append(button,detail);container.append(row);
  }
}
$('reviewNext').onclick=reviewAction(nextReview);
for(const [id,type] of [['recordLike','like'],['recordComment','comment'],['recordFollow','follow']]) $(id).onclick=reviewAction(()=>recordEngagement(type));
$('undoEngagement').onclick=reviewAction(async()=>{
  const s=await reviewSettings(),key=ENGAGEMENT_PREFIX+profileKey($('reviewHandle').value);
  await chrome.storage.local.set({[key]:(s[key]||[]).slice(0,-1)});await renderReview();
});
$('reviewHandle').addEventListener('change',()=>void renderReview());
$('outreachMode').addEventListener('change',reviewAction(async()=>{
  await saveField('outreachMode');
  await chrome.storage.local.set({runState:'paused',autoSend:false,pendingDmPrepare:null,workflowStep:null});
  $('autoSend').checked=false;
  status('Mode changed. Queue paused. Review modes require manual engagement and DM approval.');
  await renderReview();
}));
for(const id of ['start','next']){
  const original=$(id).onclick;
  $(id).onclick=reviewAction(async()=>{await store();if(reviewMode(await reviewSettings()))await nextReview();else await original()});
}
chrome.storage.onChanged?.addListener((changes,area)=>{
  if(area==='local'&&Object.keys(changes).some(k=>k.startsWith(ENGAGEMENT_PREFIX)||['outreachMode','handles','requiredLikes','requiredComments','engagementDays'].includes(k))) void renderReview();
});
uiReady.then(async()=>{$('reviewHandle').value=(await reviewSettings()).reviewHandle||'';await renderReview()}).catch(e=>status(e.message));
setInterval(()=>void renderReview().catch(()=>{}),60000);
