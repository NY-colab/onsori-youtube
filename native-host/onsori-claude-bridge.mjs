// Chrome native messaging host: lets the 「온소리 자막 in YouTube」 extension use the
// Claude Code CLI already signed in on this PC for caption typo correction, without an
// Anthropic API key. Chrome starts this program for each request from the extension IDs
// listed in its host manifest (allowed_origins) and talks to it over stdin/stdout.
//
// The bridge only ever runs one fixed command: Claude Haiku in print mode with every tool,
// hook, MCP server and session file disabled, the fixed correction prompt and JSON schema.
// The extension can send caption lines, the video title and context lines, nothing else.
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CORRECTION_SYSTEM,CORRECTION_SCHEMA,AI_CORRECTION,correctionPayload} from './ai-config.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS=Number(process.env.ONSORI_BRIDGE_TIMEOUT_MS)||110000;

export function readMessage(stream=process.stdin){
  return new Promise((resolve,reject)=>{
    let buffer=Buffer.alloc(0);
    const done=(fn,value)=>{stream.off('data',onData);stream.off('end',onEnd);stream.off('error',reject);fn(value);};
    const onData=chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(buffer.length<4)return;const size=buffer.readUInt32LE(0);
      if(size>8*1024*1024){done(reject,new Error('message too large'));return;}
      if(buffer.length>=4+size){try{done(resolve,JSON.parse(buffer.subarray(4,4+size).toString('utf8')));}catch(e){done(reject,e);}}
    };
    const onEnd=()=>done(reject,new Error('no message'));
    stream.on('data',onData);stream.on('end',onEnd);stream.on('error',reject);
  });
}
export function frame(value){const body=Buffer.from(JSON.stringify(value),'utf8'),head=Buffer.alloc(4);head.writeUInt32LE(body.length,0);return Buffer.concat([head,body]);}

export async function loadConfig(dir=here){
  try{const config=JSON.parse(await fs.readFile(path.join(dir,'config.json'),'utf8'));if(typeof config.command==='string')return {command:config.command,prefixArgs:Array.isArray(config.prefixArgs)?config.prefixArgs.map(String):[]};}catch{}
  return null;
}
function run(config,args,input,timeout=TIMEOUT_MS){
  return new Promise(resolve=>{
    let stdout='',stderr='',settled=false;
    const workDir=path.join(here,'work');
    // An empty working folder keeps project CLAUDE.md files and settings out of the request.
    fs.mkdir(workDir,{recursive:true}).catch(()=>{}).then(()=>{
      let child;
      try{child=spawn(config.command,[...config.prefixArgs,...args],{cwd:workDir,windowsHide:true,shell:false,env:{...process.env,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});}
      catch(error){resolve({error});return;}
      const timer=setTimeout(()=>{if(settled)return;settled=true;child.kill();resolve({timeout:true,stdout,stderr});},timeout);
      child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});
      child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);resolve({error});});
      child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);resolve({code,stdout,stderr});});
      child.stdin.end(input);
    });
  });
}
// Haiku 5.5 by its full name: on Claude Code 2.1.89 the "haiku" alias still meant Haiku 4.5,
// which introduced a misspelling in testing (2026-11-12). Older CLIs fall back to the alias.
export function correctionArgs(model=AI_CORRECTION.model){
  return ['-p','--model',model,'--effort','low','--tools','','--strict-mcp-config','--setting-sources','',
    '--settings',JSON.stringify({disableAllHooks:true}),'--no-session-persistence',
    '--system-prompt',CORRECTION_SYSTEM,'--json-schema',JSON.stringify(CORRECTION_SCHEMA),'--output-format','json'];
}
const failure=(code,message)=>({ok:false,code,message});
function classify(text){
  const value=String(text||'');
  if(/authenticat|oauth|401|revoked|log ?in|not logged/i.test(value))return failure('cli_auth','Claude Code 로그인이 필요합니다. 터미널에서 `claude auth login`을 실행해 다시 로그인해 주세요.');
  if(/usage limit|rate limit|429|overloaded|quota/i.test(value))return failure('rate_limited','Claude 사용 한도에 걸렸습니다. 잠시 뒤 다시 보정합니다.');
  return failure('cli_failed',`Claude Code 실행에 실패했습니다: ${value.slice(0,200)}`);
}
// Turns the CLI's single JSON result into the corrections the extension expects.
export function parseResult(stdout){
  let result;try{result=JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1));}catch{return failure('invalid_output','Claude Code 응답을 읽지 못했습니다.');}
  if(result?.is_error||result?.subtype!=='success')return classify(result?.result||result?.subtype);
  let data=result.structured_output;
  if(!data&&typeof result.result==='string'){try{data=JSON.parse(result.result.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g,''));}catch{}}
  if(!Array.isArray(data?.corrections))return failure('invalid_output','Claude Code 응답에 보정 결과가 없습니다.');
  const corrections=data.corrections.filter(c=>typeof c?.id==='string'&&typeof c.text==='string').slice(0,200).map(c=>({id:c.id.slice(0,100),text:c.text.slice(0,2000)}));
  const model=Object.keys(result.modelUsage||{}).find(name=>/haiku/i.test(name))||Object.keys(result.modelUsage||{})[0]||null;
  const usage=result.usage?{input_tokens:(result.usage.input_tokens||0)+(result.usage.cache_read_input_tokens||0)+(result.usage.cache_creation_input_tokens||0),output_tokens:result.usage.output_tokens||0}:null;
  return {ok:true,corrections,model:model&&/^[a-z0-9.-]{1,100}$/.test(model)?model:null,usage};
}
export async function handle(message,config){
  if(!config)return failure('cli_missing','Claude Code 실행 파일 위치가 설정되지 않았습니다. 연결 프로그램을 다시 설치해 주세요.');
  if(message?.type==='status'){
    const version=await run(config,['--version'],'',20000),status=await run(config,['auth','status'],'',20000);
    if(version.error||version.code!==0)return failure('cli_missing','Claude Code를 실행하지 못했습니다. 설치 위치를 확인해 주세요.');
    let auth=null;try{auth=JSON.parse(status.stdout);}catch{}
    return {ok:true,version:String(version.stdout).trim().slice(0,80),loggedIn:auth?.loggedIn===true,authMethod:typeof auth?.authMethod==='string'?auth.authMethod:null,subscription:typeof auth?.subscriptionType==='string'?auth.subscriptionType:null};
  }
  if(message?.type==='correct'){
    const payload=correctionPayload(message.payload);if(!payload.lines.length)return {ok:true,corrections:[],model:null,usage:null};
    const attempt=async model=>{
      const result=await run(config,correctionArgs(model),JSON.stringify(payload));
      if(result.error)return failure('cli_missing','Claude Code를 실행하지 못했습니다. 설치 위치를 확인해 주세요.');
      if(result.timeout)return failure('timeout','Claude Code 응답이 너무 오래 걸려 이 구간은 원문을 유지합니다.');
      if(result.code!==0&&!result.stdout.trim())return {...classify(result.stderr),detail:String(result.stderr)};
      return {...parseResult(result.stdout),detail:String(result.stdout)};
    };
    let reply=await attempt(AI_CORRECTION.model);
    if(!reply.ok&&reply.code==='cli_failed'&&/model|not_found|404/i.test(reply.detail||''))reply=await attempt('haiku');
    const {detail,...rest}=reply;return rest;
  }
  return failure('unknown_request','알 수 없는 요청입니다.');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let reply;
  try{reply=await handle(await readMessage(),await loadConfig());}catch(error){reply=failure('bridge_error',String(error?.message||error).slice(0,200));}
  process.stdout.write(frame(reply),()=>process.exit(0));
}
