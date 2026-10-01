// Executed in the X tab. Successful events require a visible confirmation from X.
let engagementBusy=false;
async function engagementGuard(job){
  if(!/^[A-Za-z0-9_]{1,15}$/.test(job.handle||'')) throw new Error('Invalid profile handle.');
  const s=await chrome.storage.local.get(null);
  const identity=await chrome.runtime.sendMessage({type:'TAB_ID'});
  if(s.runState!=='running'||!reviewMode(s)||s.engagementRunId!==job.runId||s.workflowTabId!==identity?.tabId||profileKey(s.reviewHandle)!==profileKey(job.handle)) throw new Error('Engagement queue paused or changed.');
  if(location.pathname.replace(/\/$/,'').toLowerCase()!=='/'+profileKey(job.handle)) throw new Error('The target profile is no longer open.');
  await assertAudienceAllowed(job.handle,collectProfile());
  return s;
}
function engagementPosts(handle){
  const posts=new Map();
  for(const article of document.querySelectorAll('article[data-testid="tweet"]')){
    const link=article.querySelector('[data-testid="User-Name"] a[href*="/status/"]');
    let url;try{url=new URL(link?.href,location.href)}catch{continue}
    if(!new RegExp('^/'+profileKey(handle)+'/status/\\d+/?$','i').test(url.pathname)) continue;
    // Exclude reposts and quoted-post controls; act only on the outer article.
    if(article.querySelector('[data-testid="socialContext"]')) continue;
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
    if(job.action==='posts') return {ok:true,posts:engagementPosts(job.handle).map(({post,text})=>({post,text}))};
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
    await engagementGuard(job);reply.click();
    const dialog=await waitForElement(()=>document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]')?.closest('[role="dialog"]'),8000);
    if(!dialog) throw new Error('Reply composer did not open.');
    const box=dialog.querySelector('[data-testid="tweetTextarea_0"]');
    insertIntoComposer(box,job.text.trim());await sleep(500);
    const button=dialog.querySelector('[data-testid="tweetButton"]');
    if(readComposer(box)!==job.text.trim()||!button||button.disabled||button.getAttribute('aria-disabled')==='true') throw new Error('Reply text or submit button is not ready.');
    const oldLinks=new Set([...document.querySelectorAll('[data-testid="toast"] a[href*="/status/"]')].map(a=>a.href));
    await engagementGuard(job);
    await chrome.storage.local.set({[pendingKey]:{text:job.text,at:Date.now()}});
    await engagementGuard(job);
    if(!button.isConnected||readComposer(box)!==job.text.trim()) throw new Error('Reply changed before submission.');
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
