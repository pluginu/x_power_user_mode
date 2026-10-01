// Read-only matching of loaded timeline post authors; no navigation or engagement.
let timelineScanBusy=false;
async function highlightTimelineMatches(){
  if(timelineScanBusy) return;
  timelineScanBusy=true;
  try{
    const s=await chrome.storage.local.get(['timelineMonitoring','handles']);
    const enabled=s.timelineMonitoring==='on' && /^\/home\/?$/.test(location.pathname);
    const handles=new Set(String(s.handles||'').split(/[\n,]/).map(profileKey).filter(Boolean));
    for(const article of document.querySelectorAll('article[data-testid="tweet"]')){
      const author=article.querySelector('[data-testid="User-Name"] a[href*="/status/"]')||article.querySelector('a[href*="/status/"] time')?.closest('a');
      let handle='';
      try{handle=profileKey(new URL(author?.href,location.href).pathname.match(/^\/([^/]+)\/status\/\d+/)?.[1])}catch{}
      const match=enabled&&handles.has(handle);
      article.toggleAttribute('data-sin-review-match',match);
      const old=article.querySelector('[data-sin-review-badge]');
      if(!match){old?.remove();continue}
      if(old){old.textContent=`SIN review list: @${handle}`;continue}
      const badge=document.createElement('div');badge.setAttribute('data-sin-review-badge','');
      badge.textContent=`SIN review list: @${handle}`;
      badge.style.cssText='padding:6px 12px;color:#9ad;font-size:13px;border:1px solid #9ad;border-radius:6px;pointer-events:none';
      article.prepend(badge);
    }
  }finally{timelineScanBusy=false}
}
setInterval(()=>void highlightTimelineMatches().catch(()=>{}),3000);
void highlightTimelineMatches().catch(()=>{});
chrome.storage.onChanged?.addListener((changes,area)=>{if(area==='local'&&(changes.timelineMonitoring||changes.handles))void highlightTimelineMatches().catch(()=>{})});
