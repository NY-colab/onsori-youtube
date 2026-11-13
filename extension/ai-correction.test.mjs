import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptCorrection,correctDocumentSpeech,correctionTargets,requestCorrections,verifyCorrectionKey,loadSdk,mergeCorrectionRecords,createCliClient,FATAL_CORRECTION_CODES,AI_CORRECTION,API_KEY_PATTERN,apiKeyHint} from './ai-correction.js';
import {validateDocument} from './core.js';
import {serverCorrectionLabel,MODEL_ID_PATTERN,correctionSourceTag} from './ai-config.js';

const cue=(id,text,extra={})=>({id,start:0,end:1,text,kind:'speech',scale:1,dbfs:null,relative_db:null,confidence:null,source:'whisper-browser-wasm',review_required:true,...extra});
const doc=cues=>({schema_version:'1.0',video_id:'abcdefghijk',title:'경제 뉴스',duration:30,cues,warnings:[],metadata:{}});
function fakeClient(reply){const calls=[];return {calls,messages:{async create(body,options){calls.push({body,options});return typeof reply==='function'?reply(body):reply;}}};}
const answer=(corrections,stop='end_turn')=>({stop_reason:stop,content:[{type:'text',text:JSON.stringify({corrections})}],usage:{input_tokens:100,output_tokens:20}});
const KEY='sk-ant-api03-'+'k'.repeat(40);

test('accepts typo and spacing fixes, rejects rewrites, additions and sound marks',()=>{
  assert.equal(acceptCorrection('금리가 인상 됬습니다','금리가 인상됐습니다'),'금리가 인상됐습니다');
  assert.equal(acceptCorrection('한국은행이 기준 금니를 올렸다','한국은행이 기준 금리를 올렸다'),'한국은행이 기준 금리를 올렸다');
  assert.equal(acceptCorrection('오늘은날씨가좋네요','오늘은 날씨가 좋네요'),'오늘은 날씨가 좋네요');
  assert.equal(acceptCorrection('안녕하세요','안녕하세요'),null);
  assert.equal(acceptCorrection('오늘 날씨가 좋네요','내일은 비가 많이 올 예정이라고 합니다'),null);
  assert.equal(acceptCorrection('그래서 우리는','그래서 우리는 결국 모든 것을 포기하고 떠났습니다'),null);
  assert.equal(acceptCorrection('네 알겠습니다','♪ 네 알겠습니다 ♪'),null);
  assert.equal(acceptCorrection('네 알겠습니다',''),null);
});
test('keys are checked by shape and only a hint is ever shown',()=>{
  assert.ok(API_KEY_PATTERN.test(KEY));assert.equal(API_KEY_PATTERN.test('sk-proj-abc'),false);assert.equal(API_KEY_PATTERN.test(KEY+' '),false);
  assert.equal(apiKeyHint(KEY),'sk-ant-api…kkkk');assert.equal(apiKeyHint('nope'),'');
});
test('Claude Haiku corrects only recognized speech and keeps the original text',async()=>{
  const d=doc([cue('a','기준 금니를 올렸습니다'),cue('b','네 맞습니다'),cue('c','참조 자막',{source:'whisper-browser-wasm+youtube-native-caption',speech_correction:{}}),cue('d','클라우드 대사',{source:'onsori-cloud-speech'}),cue('m','♬ 음악 ♬',{kind:'music',source:'AST-browser-wasm'}),cue('i','가져온 자막',{source:'import'})]);
  assert.deepEqual(correctionTargets(d).map(c=>c.id),['a','b','d']);
  const client=fakeClient(answer([{id:'a',text:'기준 금리를 올렸습니다'},{id:'b',text:'전혀 다른 문장으로 바꿔 버렸습니다'},{id:'d',text:' 클라우드  대사 '},{id:'zz',text:'없는 줄'},{id:'m',text:'음악'}]));
  await correctDocumentSpeech(d,{client,context:['앞 대사']});
  assert.equal(d.cues[0].text,'기준 금리를 올렸습니다');assert.deepEqual(d.cues[0].ai_correction,{original_text:'기준 금니를 올렸습니다',model:AI_CORRECTION.model});assert.match(d.cues[0].source,/\+claude-haiku$/);
  assert.equal(d.cues[1].text,'네 맞습니다');assert.equal(d.cues[1].ai_correction,undefined);assert.equal(d.cues[4].text,'♬ 음악 ♬');
  assert.equal(d.cues[3].text,'클라우드 대사');assert.equal(d.cues[3].ai_correction,undefined);// an unchanged echo is neither corrected nor rejected
  assert.deepEqual({...d.metadata.ai_correction},{model:'claude-haiku-5-5',status:'done',checked:3,corrected:1,rejected:1,input_tokens:100,output_tokens:20});
  const {body,options}=client.calls[0];
  assert.equal(body.model,'claude-haiku-5-5');assert.equal(body.output_config.effort,'low');assert.equal(body.output_config.format.type,'json_schema');assert.equal(body.output_config.format.schema.additionalProperties,false);
  assert.equal(body.thinking,undefined);assert.equal(body.temperature,undefined);assert.equal(options.signal,undefined);
  const payload=JSON.parse(body.messages[0].content);assert.deepEqual(payload.lines.map(l=>l.id),['a','b','d']);assert.deepEqual(payload.context,['앞 대사']);assert.equal(payload.title,'경제 뉴스');
  assert.equal(JSON.stringify(body).includes('pcm'),false);
  const valid=validateDocument({...d,cues:d.cues.filter(c=>c.id!=='c')});assert.equal(valid.cues.find(c=>c.id==='a').ai_correction.original_text,'기준 금니를 올렸습니다');
  assert.throws(()=>validateDocument({...valid,cues:[{...valid.cues[0],ai_correction:{original_text:'x',model:'Bad Model!'}}]}),/AI 보정/);
  const again=fakeClient(answer([]));await correctDocumentSpeech(d,{client:again});assert.deepEqual(JSON.parse(again.calls[0].body.messages[0].content).lines.map(l=>l.id),['b','d']);
});
test('long minutes are sent in batches with the previous lines as context',async()=>{
  const d=doc(Array.from({length:100},(_,i)=>cue(`s${i}`,`대사 ${i}번`)));const client=fakeClient(answer([]));
  await correctDocumentSpeech(d,{client});assert.equal(client.calls.length,2);
  const second=JSON.parse(client.calls[1].body.messages[0].content);assert.equal(second.lines.length,20);assert.deepEqual(second.context,['대사 76번','대사 77번','대사 78번','대사 79번']);
});
test('refusal, truncation and unreadable answers keep the recognized text',async()=>{
  for(const [reply,code] of [[answer([{id:'a',text:'고친 대사'}],'refusal'),'refusal'],[answer([],'max_tokens'),'truncated'],[{stop_reason:'end_turn',content:[{type:'text',text:'not json'}]},'invalid_output']]){
    const d=doc([cue('a','고칠 대사')]);await assert.rejects(correctDocumentSpeech(d,{client:fakeClient(reply)}),{code});assert.equal(d.cues[0].text,'고칠 대사');
  }
  await assert.rejects(correctDocumentSpeech(doc([cue('a','대사')]),{apiKey:'wrong'}),{code:'no_key'});
  const none=doc([cue('m','♬ 음악 ♬',{kind:'music',source:'AST-browser-wasm'})]);await correctDocumentSpeech(none,{apiKey:'wrong'});assert.equal(none.metadata.ai_correction.checked,0);
  assert.equal(mergeCorrectionRecords({status:'done',checked:2,corrected:1},{status:'failed',checked:0,corrected:0,error:'x'}).status,'partial');
});
test('the bundled Anthropic SDK sends a direct browser request and API errors map by type',async()=>{
  const {Anthropic}=await loadSdk(),seen=[];
  const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const fetch=async(url,init)=>{seen.push({url:String(url),init});return String(url).includes('/v1/models/')?json(200,{id:'claude-haiku-5-5',type:'model',display_name:'Claude Haiku 5.5',created_at:'2026-10-01T00:00:00Z'}):json(200,{id:'msg_1',type:'message',role:'assistant',model:'claude-haiku-5-5',content:[{type:'text',text:'{"corrections":[{"id":"a","text":"안녕하세요."}]}'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:5,output_tokens:2}});};
  const client=new Anthropic({apiKey:KEY,dangerouslyAllowBrowser:true,fetch,maxRetries:0});
  const result=await requestCorrections({lines:[{id:'a',text:'안녕하세요'}],client});assert.deepEqual(result.corrections,[{id:'a',text:'안녕하세요.'}]);
  const headers=new Headers(seen[0].init.headers),body=JSON.parse(seen[0].init.body);
  assert.equal(seen[0].url,'https://api.anthropic.com/v1/messages');assert.ok(headers.get('x-api-key')===KEY||headers.get('authorization')==='Bearer '+KEY);assert.equal(headers.get('anthropic-dangerous-direct-browser-access'),'true');
  assert.equal(body.model,'claude-haiku-5-5');assert.equal(body.output_config.format.type,'json_schema');
  assert.equal((await verifyCorrectionKey(KEY,{client})).name,'Claude Haiku 5.5');assert.match(seen.at(-1).url,/\/v1\/models\/claude-haiku-5-5$/);
  const failing=status=>new Anthropic({apiKey:KEY,dangerouslyAllowBrowser:true,maxRetries:0,fetch:async()=>json(status,{type:'error',error:{type:'error',message:'nope'}})});
  for(const [status,code] of [[401,'invalid_key'],[403,'forbidden'],[404,'model_unavailable'],[429,'rate_limited'],[400,'bad_request'],[500,'server']])await assert.rejects(requestCorrections({lines:[{id:'a',text:'대사'}],client:failing(status)}),{code});
  await assert.rejects(verifyCorrectionKey(KEY,{client:failing(401)}),{code:'invalid_key'});
  const offline=new Anthropic({apiKey:KEY,dangerouslyAllowBrowser:true,maxRetries:0,fetch:async()=>{throw new TypeError('Failed to fetch');}});
  await assert.rejects(requestCorrections({lines:[{id:'a',text:'대사'}],client:offline}),{code:'network'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(requestCorrections({lines:[{id:'a',text:'대사'}],client,signal:controller.signal}),{name:'AbortError'});
});
test('the Claude Code client relays only caption text and stops on bridge or sign-in failures',async()=>{
  const sent=[],client=createCliClient(async message=>{sent.push(message);return {ok:true,corrections:[{id:'a',text:'기준 금리를 올렸습니다'}],model:'claude-haiku-4-5',usage:{input_tokens:3,output_tokens:2}};});
  const d=doc([cue('a','기준 금니를 올렸습니다')]);await correctDocumentSpeech(d,{client,context:['앞 대사']});
  assert.equal(d.cues[0].text,'기준 금리를 올렸습니다');assert.equal(d.cues[0].ai_correction.model,'claude-haiku-4-5');assert.equal(d.metadata.ai_correction.model,'claude-haiku-4-5');
  assert.equal(sent[0].type,'CLI_CORRECT');assert.deepEqual(Object.keys(sent[0]).sort(),['payload','type']);assert.deepEqual(sent[0].payload,{title:'경제 뉴스',context:['앞 대사'],lines:[{id:'a',text:'기준 금니를 올렸습니다'}]});
  for(const [reply,code] of [[{ok:false,code:'cli_auth',message:'로그인이 필요합니다.'},'cli_auth'],[{ok:false,code:'bridge_missing',message:'설치 필요'},'bridge_missing'],[null,'cli_failed']]){
    const failing=doc([cue('a','대사')]);await assert.rejects(correctDocumentSpeech(failing,{client:createCliClient(async()=>reply)}),{code});assert.equal(failing.cues[0].text,'대사');
  }
  assert.ok(['cli_auth','bridge_missing','bridge_forbidden','no_permission','cli_missing'].every(code=>FATAL_CORRECTION_CODES.includes(code)));
  const controller=new AbortController();controller.abort();await assert.rejects(createCliClient(async()=>({ok:true,corrections:[]})).messages.create({messages:[{content:'{}'}]},{signal:controller.signal}),{name:'AbortError'});
});
test('server corrections record the DeepInfra model the server names, and the document stays valid',async()=>{
  const sent=[],client=createCliClient(async message=>{sent.push(message);return {ok:true,corrections:[{id:'a',text:'기준 금리를 올렸습니다'}],model:'deepseek-ai/DeepSeek-V4-Flash-0731',usage:{input_tokens:900,output_tokens:40}};},'CLOUD_CORRECT');
  const d=doc([cue('a','기준 금니를 올렸습니다')]);await correctDocumentSpeech(d,{client,model:'deepseek-ai/DeepSeek-V4-Flash-0731'});
  assert.equal(sent[0].type,'CLOUD_CORRECT');
  assert.deepEqual(d.cues[0].ai_correction,{original_text:'기준 금니를 올렸습니다',model:'deepseek-ai/DeepSeek-V4-Flash-0731'});
  assert.equal(d.cues[0].source,'whisper-browser-wasm+ai-correction');assert.equal(d.metadata.ai_correction.model,'deepseek-ai/DeepSeek-V4-Flash-0731');
  assert.equal(validateDocument(d).cues[0].ai_correction.model,'deepseek-ai/DeepSeek-V4-Flash-0731');
  // An unusable model name from the server is not recorded; the requested model is kept.
  const odd=doc([cue('a','기준 금니를 올렸습니다')]);
  await correctDocumentSpeech(odd,{client:createCliClient(async()=>({ok:true,corrections:[{id:'a',text:'기준 금리를 올렸습니다'}],model:'<img src=x>'}),'CLOUD_CORRECT'),model:'deepseek-ai/DeepSeek-V4-Flash-0731'});
  assert.equal(odd.cues[0].ai_correction.model,'deepseek-ai/DeepSeek-V4-Flash-0731');
});
test('the server provider and model become a short label; Claude keeps its tag',()=>{
  assert.equal(serverCorrectionLabel('deepinfra','deepseek-ai/DeepSeek-V4-Flash-0731'),'DeepInfra · DeepSeek V4 Flash');
  assert.equal(serverCorrectionLabel('deepinfra','Qwen/Qwen3.8-Flash'),'DeepInfra · Qwen3.8 Flash');
  assert.equal(serverCorrectionLabel('anthropic','claude-haiku-5-5'),'Anthropic · Claude Haiku 5.5');
  assert.equal(serverCorrectionLabel('deepinfra',null),'DeepInfra');assert.equal(serverCorrectionLabel(null,'<b>x</b>'),'AI 모델');assert.equal(serverCorrectionLabel('evil','m'),'m');
  assert.ok(MODEL_ID_PATTERN.test('deepseek-ai/DeepSeek-V4-Flash-0731'));assert.equal(MODEL_ID_PATTERN.test('a b'),false);assert.equal(MODEL_ID_PATTERN.test('x'.repeat(101)),false);
  assert.equal(correctionSourceTag('claude-haiku-5-5'),'claude-haiku');assert.equal(correctionSourceTag('deepseek-ai/DeepSeek-V4-Flash-0731'),'ai-correction');
});
