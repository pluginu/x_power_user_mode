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
    // A confirmed send outranks later skip/review records to prevent repeat outreach.
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
  // Preserve the original send timestamp when later operations update this recipient.
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
  await assertAudienceAllowed(handle);
  if(s.outreachMode==='staged_review'){
    if(automatic) throw new Error('Staged outreach requires manual approval for each DM.');
    if(!engagementEligibility(s,s[ENGAGEMENT_PREFIX+profileKey(handle)]||[]).eligible) throw new Error('Engagement requirements or waiting period are not complete for this profile.');
  }
}

// Match only explicit, conservative location forms. Free-text location is self-reported,
// so ambiguous cities, bare state abbreviations, and multiple locations fail closed.
const US_STATES='Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia';
const US_CODES='AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
function statedUsLocation(value){
  const location=String(value||'').trim().replace(/\s+/g,' ');
  if(/[/|;&🌎🌍🌏]/u.test(location)) return false;
  const country='(?:USA|U\\.S\\.A\\.?|US|U\\.S\\.?|United States(?: of America)?)';
  if(new RegExp('^'+country+'$','i').test(location)) return true;
  const state='(?:'+US_STATES+')';
  // Georgia alone also names a country; require a city or explicit USA suffix.
  if(location.toLowerCase()!=='georgia' && new RegExp('^'+state+'$','i').test(location)) return true;
  const city='[A-Za-z][A-Za-z .\\x27-]*';
  const region='(?:'+state+'|'+US_CODES+')';
  return new RegExp('^(?:'+city+', )?'+region+'(?:, '+country+')?$','i').test(location) &&
    (location.includes(',') || location.toLowerCase()!=='georgia' && new RegExp('^'+state+'$','i').test(location));
}
function followerCount(value){
  const text=String(value??'').trim().replace(/\s+followers?$/i,'');
  const match=text.match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([KMB])?$/i);
  // Keep unreadable counts distinct from zero so eligibility cannot accept missing data.
  if(!match) return null;
  const count=Number(match[1].replaceAll(',',''))*({K:1e3,M:1e6,B:1e9}[match[2]?.toUpperCase()]||1);
  return Number.isFinite(count)?Math.round(count):null;
}
function audienceReview(settings,profile){
  const reject=reason=>({eligible:false,reason});
  // Missing settings in older installs retain the default-on audience checks.
  if(settings.usaOnly!=='off' && !statedUsLocation(profile?.location)) return reject('USA-only review: location is missing, ambiguous, or outside the supported US location forms.');
  if(settings.followerReview!=='off'){
    const count=followerCount(profile?.followers);
    const min=Number(settings.minFollowers||0),max=settings.maxFollowers==null||settings.maxFollowers===''?Infinity:Number(settings.maxFollowers);
    if(!Number.isInteger(min)||min<0||!(max===Infinity||Number.isInteger(max)&&max>=min)) return reject('Follower review: enter valid minimum/maximum counts.');
    if(count===null) return reject('Follower review: follower count is unavailable or unreadable.');
    if(count<min||count>max) return reject(`Follower review: ${count} followers is outside the configured range.`);
  }
  if(settings.requireFollowBack==='on' && profile?.followsYou!==true) return reject('Follower review: this profile does not visibly follow you.');
  return {eligible:true,reason:'Passed the configured location and follower checks.'};
}
async function assertAudienceAllowed(handle,liveProfile){
  const settings=await chrome.storage.local.get(null);
  const profile=liveProfile||(await readProfiles())[profileKey(handle)];
  if(liveProfile && profileKey(liveProfile.handle)!==profileKey(handle)) throw new Error('Profile changed before audience review.');
  const review=audienceReview(settings,profile);
  if(!review.eligible) throw new Error(review.reason);
}
