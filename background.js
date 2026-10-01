// Normalize all model-generated strings before they reach UI, logs, or storage.
function cleanLlmOutput(value){
  if(typeof value==='string') return value.replace(/[ \t]*[\u2014\u2015][ \t]*/g, ', ');
  if(Array.isArray(value)) return value.map(cleanLlmOutput);
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,cleanLlmOutput(item)]));
  return value;
}
chrome.runtime.onMessage.addListener((msg,sender,send)=>{
  if(msg.type==='TAB_ID'){send({tabId:sender.tab?.id});return}
  if(msg.type!=='OPENAI_DRAFT') return;
  (async()=>{
    const started=Date.now();
    try{
      if(!msg.apiKey) throw new Error('Missing OpenAI API key.');
      const model=msg.model||'gpt-5';
      const schema={
        type:'object',
        additionalProperties:false,
        properties:{
          message:{type:'string',description:'The final DM text, ready to paste into X.'},
          personalization_basis:{type:'string',description:'Short description of the public profile fact used for personalization, or empty string.'},
          greeting_context:{type:'string',description:'Greeting/time context actually used, or empty string.'},
          safety_check:{type:'string',enum:['passed']}
        },
        required:['message','personalization_basis','greeting_context','safety_check']
      };
      const body={
        model,
        instructions:'Do not use em dashes (U+2014) or horizontal bars (U+2015) in any output field. Use commas or periods instead.',
        input:msg.prompt,
        max_output_tokens:1200,
        reasoning:{effort:'minimal'},
        text:{verbosity:'low',format:{type:'json_schema',name:'sin_outreach_draft',description:'A structured SIN outreach draft.',strict:true,schema}}
      };
      const r=await fetch('https://api.openai.com/v1/responses',{
        method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+msg.apiKey},body:JSON.stringify(body),signal:AbortSignal.timeout(110000)
      });
      const raw=await r.text();
      let j={}; try{j=JSON.parse(raw)}catch{}
      if(!r.ok) throw new Error(`OpenAI ${r.status}: ${j?.error?.message||raw.slice(0,800)||'request failed'}`);
      if(j.status && j.status!=='completed'){
        const reason=j.incomplete_details?.reason||j.error?.message||'unknown';
        const usage=j.usage||{};
        const reasoning=usage.output_tokens_details?.reasoning_tokens ?? 'n/a';
        throw new Error(`OpenAI response status: ${j.status}. Reason: ${reason}. max_output_tokens=1200; output_tokens=${usage.output_tokens ?? 'n/a'}; reasoning_tokens=${reasoning}.`);
      }
      const outputText=(j.output||[]).flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text||'').join('').trim() || j.output_text || '';
      if(!outputText) throw new Error(`OpenAI returned no structured output. Response id: ${j.id||'unknown'}; status: ${j.status||'unknown'}; output types: ${(j.output||[]).map(x=>x.type).join(',')||'none'}`);
      let parsed; try{parsed=cleanLlmOutput(JSON.parse(outputText))}catch(e){throw new Error(`Structured output was not valid JSON: ${e.message}. Raw: ${outputText.slice(0,500)}`)}
      if(!parsed?.message?.trim()) throw new Error('Structured response parsed, but message was empty.');
      send({ok:true,text:parsed.message.trim(),structured:parsed,debug:{model,responseId:j.id||'',status:j.status||'',elapsedMs:Date.now()-started,usage:j.usage||{},maxOutputTokens:1200,reasoningEffort:'minimal'}});
    }catch(e){send({ok:false,error:cleanLlmOutput(e?.message||String(e)),debug:{elapsedMs:Date.now()-started}})}
  })();
  return true;
});
