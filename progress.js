// Completion records are independent keys so an overlapping profile-map write
// cannot erase another recipient's progress. Backups include these keys too.
const PROCESSED_PREFIX='processedProfile:';
const PROCESSED_STATUSES=new Set(['contacted','dm_unavailable','account_not_found','account_suspended','skipped','needs_review']);
function profileKey(handle){return String(handle||'').trim().replace(/^@/,'').toLowerCase()}
function isProcessed(record){return !!record && (record.contacted===true || !!record.contactedAt || PROCESSED_STATUSES.has(record.processingStatus))}
function normalizeRecord(record,handle){
  const result={...record,handle:record.handle||handle};
  if(result.contacted===true || result.contactedAt) result.processingStatus='contacted';
  return result;
}
async function readProfiles(){
  const all=await chrome.storage.local.get(null),profiles={};
  for(const [key,record] of Object.entries(all.profiles||{})){
    if(!record || typeof record!=='object') continue;
    const handle=profileKey(record.handle||key);
    const normalized=normalizeRecord(record,handle);
    // Old backups may contain differently cased keys for the same recipient.
    profiles[handle]=isProcessed(profiles[handle])?{...normalized,...profiles[handle]}:{...profiles[handle],...normalized};
  }
  for(const [key,record] of Object.entries(all)){
    if(!key.startsWith(PROCESSED_PREFIX)||!isProcessed(record)) continue;
    const handle=profileKey(key.slice(PROCESSED_PREFIX.length));
    const existing=profiles[handle]||{};
    profiles[handle]=normalizeRecord({...existing,...record,
      ...(existing.processingStatus==='contacted'?{processingStatus:'contacted',contacted:true,contactedAt:existing.contactedAt||record.contactedAt}:{})},handle);
  }
  return profiles;
}
async function persistProcessedProfile(record){
  if(!record?.handle || !isProcessed(record)) return;
  const key=PROCESSED_PREFIX+profileKey(record.handle);
  const old=(await chrome.storage.local.get(key))[key];
  const merged=normalizeRecord({...old,...record},record.handle);
  if(old?.processingStatus==='contacted') Object.assign(merged,{processingStatus:'contacted',contacted:true,contactedAt:old.contactedAt||record.contactedAt});
  await chrome.storage.local.set({[key]:merged});
}
async function restoreProcessedProfiles(){
  const profiles=await readProfiles();
  for(const record of Object.values(profiles)) await persistProcessedProfile(record);
  // Recover older versions that only saved the send result in the pending job.
  const {pendingDmPrepare:pending}=await chrome.storage.local.get('pendingDmPrepare');
  if(pending?.stage==='sent' && pending.handle){
    const handle=profileKey(pending.handle),now=new Date().toISOString();
    profiles[handle]={...profiles[handle],handle:pending.handle,processingStatus:'contacted',contacted:true,
      contactedAt:profiles[handle]?.contactedAt||pending.updatedAt||now,draft:pending.draft,lastUpdated:now};
    await persistProcessedProfile(profiles[handle]);
  }
}

// Manual engagement is stored independently of collection/contact history.
const ENGAGEMENT_PREFIX='engagement:';
function reviewMode(settings){return ['follow_review','staged_review'].includes(settings.outreachMode)}
function engagementEligibility(settings,events=[],now=Date.now()){
  // Recompute from surviving records so undoing the first interaction also resets the waiting period.
  const count=value=>Math.max(0,Math.floor(Number(value)||0));
  const valid=events.filter(e=>Number.isFinite(e.at)&&e.at<=now);
  const likes=new Set(valid.filter(e=>e.type==='like').map(e=>e.post)).size;
  const comments=new Set(valid.filter(e=>e.type==='comment').map(e=>e.post)).size;
  const followed=valid.some(e=>e.type==='follow');
  const first=valid.length?Math.min(...valid.map(e=>e.at)):null;
  const eligibleAt=first===null?null:first+Math.max(0,Number(settings.engagementDays)||0)*86400000;
  const eligible=followed&&likes>=count(settings.requiredLikes)&&comments>=count(settings.requiredComments)&&eligibleAt!==null&&now>=eligibleAt;
  return {likes,comments,followed,eligibleAt,eligible};
}
async function assertReviewDmAllowed(handle,automatic=false){
  // Read the latest mode at the action boundary; another popup or panel may have changed it.
  const s=await chrome.storage.local.get(null);
  if(s.outreachMode==='follow_review') throw new Error('No-DM review mode is enabled.');
  if(s.outreachMode==='staged_review'){
    if(automatic) throw new Error('Staged outreach requires manual approval for each DM.');
    if(!engagementEligibility(s,s[ENGAGEMENT_PREFIX+profileKey(handle)]||[]).eligible) throw new Error('Engagement requirements or waiting period are not complete for this profile.');
  }
}
