// Executed in the X tab. Successful events require a visible confirmation from X.
let engagementBusy=false;
// A reply composer is bound only after clicking Reply on the verified target post.
// X can render that post in the dialog without a clickable status permalink.
const replyDialogTargets=new WeakMap();
function engagementPostId(value){
  try{
    const url=new URL(value,location.href);
    if(!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)) return null;
    return url.pathname.match(/^\/[A-Za-z0-9_]+\/status\/(\d+)(?:\/|$)/)?.[1]||null;
  }catch{return null}
}
function currentReplyDialog(){
  return document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]')?.closest('[role="dialog"]')||null;
}
async function engagementGuard(job,replyDialog=null){
  if(!/^[A-Za-z0-9_]{1,15}$/.test(job.handle||'')) throw new Error('Invalid profile handle.');
  const s=await chrome.storage.local.get(null);
  const identity=await chrome.runtime.sendMessage({type:'TAB_ID'});
  if(s.runState!=='running'||!reviewMode(s)||s.engagementRunId!==job.runId||s.workflowTabId!==identity?.tabId||profileKey(s.reviewHandle)!==profileKey(job.handle)) throw new Error('Engagement queue paused or changed.');
  const onProfile=location.pathname.replace(/\/$/,'').toLowerCase()==='/'+profileKey(job.handle);
  if(replyDialog){
    const target=replyDialogTargets.get(replyDialog);
    if(!replyDialog.isConnected||currentReplyDialog()!==replyDialog) throw new Error('The reply composer was closed or replaced. Close any open draft and resume.');
    if(!target||target.runId!==job.runId||target.post!==job.post||target.handle!==profileKey(job.handle)) throw new Error('The reply composer is not bound to this queued post.');
    // A missing permalink is normal. If X exposes post links, check their IDs,
    // allowing tracking queries and media suffixes without relying on URL spelling.
    const postIds=[...replyDialog.querySelectorAll('a[href*="/status/"]')].map(link=>engagementPostId(link.href)).filter(Boolean);
    if(postIds.length&&!postIds.includes(engagementPostId(job.post))) throw new Error('The reply composer shows a different post. Close it and resume.');
  }
  if(!onProfile&&!(replyDialog&&/^\/compose\/(post|tweet)\/?$/.test(location.pathname))) throw new Error('The target profile is no longer open.');
  // X changes the URL to /compose/post while the bound reply dialog is open.
  await assertAudienceAllowed(job.handle,onProfile?collectProfile():undefined);
  return s;
}
function engagementPosts(handle){
  const posts=new Map();
  for(const article of document.querySelectorAll('article[data-testid="tweet"]')){
    // Use the outer post's timestamp first. It need not live inside User-Name.
    // Never select a quoted post just because its author matches the target.
    const timestamp=[...article.querySelectorAll('time')].find(time=>{
      const anchor=time.closest('a[href*="/status/"]');
      return time.closest('article')===article && anchor && !anchor.parentElement?.closest('[data-testid="quoteTweet"],[role="link"]');
    });
    const link=timestamp?.closest('a[href*="/status/"]')||article.querySelector('[data-testid="User-Name"] a[href*="/status/"]');
    let url;try{url=new URL(link?.href,location.href)}catch{continue}
    const match=url.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)\/?$/);
    if(!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||!match||profileKey(match[1])!==profileKey(handle)) continue;
    // Pinned posts also have socialContext; they are eligible original posts.
    const context=article.querySelector('[data-testid="socialContext"]')?.innerText||'';
    if(/\b(reposted|retweeted)\b/i.test(context)) continue;
    const post='https://x.com'+url.pathname.replace(/\/$/,'');
    posts.set(post,{post,text:article.querySelector('[data-testid="tweetText"]')?.innerText||'',article});
  }
  return [...posts.values()];
}
async function confirmedEngagement(handle,type,post=''){
  const key=ENGAGEMENT_PREFIX+profileKey(handle),s=await chrome.storage.local.get(key);
  const events=s[key]||[];
  if(!events.some(e=>e.confirmed===true&&e.type===type&&e.post===post)) await chrome.storage.local.set({[key]:[...events,{type,post,at:Date.now(),confirmed:true}]});
}
async function executeEngagement(job){
  if(engagementBusy) throw new Error('An engagement action is already running.');
  engagementBusy=true;
  try{
    await engagementGuard(job);
    if(job.action==='posts') return {ok:true,posts:engagementPosts(job.handle).map(({post,text})=>({post,text})),loadedArticles:document.querySelectorAll('article[data-testid="tweet"]').length};
    if(job.action==='follow'){
      const result=await ensureFollowingOnPage(job.handle,job);
      if(!result.ok) return result;
      await confirmedEngagement(job.handle,'follow');return result;
    }
    const found=engagementPosts(job.handle).find(p=>p.post===job.post);
    if(!found) throw new Error('Target post is no longer loaded.');
    const key=ENGAGEMENT_PREFIX+profileKey(job.handle);
    const s=await chrome.storage.local.get(null);
    if((s[key]||[]).some(e=>e.confirmed&&e.type===job.action&&e.post===job.post)) return {ok:true,alreadyCompleted:true};
    if(job.action==='like'){
      if(!found.article.querySelector('[data-testid="unlike"]')){
        const button=found.article.querySelector('[data-testid="like"]');
        if(!button) throw new Error('Like button is unavailable.');
        await engagementGuard(job);
        if(!button.isConnected) throw new Error('Post changed before Like.');
        button.click();
        const confirmed=await waitForElement(()=>engagementPosts(job.handle).find(p=>p.post===job.post)?.article.querySelector('[data-testid="unlike"]'),9000);
        if(!confirmed) throw new Error('X did not confirm the like. Queue paused.');
      }
      await confirmedEngagement(job.handle,'like',job.post);return {ok:true};
    }
    if(job.action!=='comment') throw new Error('Unknown engagement action.');
    if(!job.text?.trim()||job.text.length>280) throw new Error('Comment must contain 1–280 characters.');
    const pendingKey='pendingComment:'+job.post;
    if(s[pendingKey]) throw new Error('An earlier comment submission is unconfirmed. Check X before retrying; this post will not be submitted twice.');
    if(document.querySelector('[role="dialog"]')) throw new Error('Close the existing X dialog first.');
    const reply=found.article.querySelector('[data-testid="reply"]');
    if(!reply) throw new Error('Reply button is unavailable.');
    await engagementGuard(job);
    const livePost=engagementPosts(job.handle).find(p=>p.post===job.post);
    if(!reply.isConnected||livePost?.article.querySelector('[data-testid="reply"]')!==reply) throw new Error('Target post changed before opening Reply.');
    reply.click();
    const dialog=await waitForElement(currentReplyDialog,8000);
    if(!dialog) throw new Error('Reply composer did not open.');
    replyDialogTargets.set(dialog,{runId:job.runId,post:job.post,handle:profileKey(job.handle)});
    await engagementGuard(job,dialog);
    const box=dialog.querySelector('[data-testid="tweetTextarea_0"]');
    await insertIntoComposer(box,job.text.trim());
    let stableSince=null;
    const button=await waitForElement(()=>{
      const liveBox=dialog.querySelector('[data-testid="tweetTextarea_0"]');
      const submit=dialog.querySelector('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]');
      if(!box.isConnected||liveBox!==box||readComposer(box)!==job.text.trim()||!submit||submit.disabled||submit.getAttribute('aria-disabled')==='true'){stableSince=null;return null}
      stableSince??=Date.now();
      return Date.now()-stableSince>=800?submit:null;
    },8000);
    if(!button) throw new Error('Reply text or submit button is not ready. Close the reply dialog and resume; nothing was submitted.');
    const oldLinks=new Set([...document.querySelectorAll('[data-testid="toast"] a[href*="/status/"]')].map(a=>a.href));
    await engagementGuard(job,dialog);
    if(!button.isConnected||readComposer(box)!==job.text.trim()) throw new Error('Reply changed before submission.');
    await chrome.storage.local.set({[pendingKey]:{text:job.text,at:Date.now()}});
    try{
      await engagementGuard(job,dialog);
      if(!button.isConnected||readComposer(box)!==job.text.trim()||button.disabled||button.getAttribute('aria-disabled')==='true') throw new Error('Reply changed before submission.');
    }catch(e){await chrome.storage.local.remove(pendingKey);throw e}
    button.click();
    const receipt=await waitForElement(()=>[...document.querySelectorAll('[data-testid="toast"] a[href*="/status/"]')].find(a=>!oldLinks.has(a.href)&&a.href!==job.post),12000);
    if(!receipt) throw new Error('Comment submitted but X did not return a post link. Queue paused; no completion recorded and no automatic retry.');
    await confirmedEngagement(job.handle,'comment',job.post);
    await chrome.storage.local.remove(pendingKey);
    return {ok:true};
  }finally{engagementBusy=false}
}
chrome.runtime.onMessage.addListener((msg,sender,send)=>{
  if(msg.type!=='ENGAGEMENT') return;
  executeEngagement(msg).then(send,e=>send({ok:false,error:e.message}));return true;
});
