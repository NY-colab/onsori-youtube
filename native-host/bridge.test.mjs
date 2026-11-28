import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readMessage,frame,handle,parseResult,correctionArgs,loadConfig} from './onsori-claude-bridge.mjs';
import {install,unpackedExtensionId,findClaude,WEB_STORE_ID} from './install.mjs';
import {CORRECTION_SYSTEM} from '../extension/ai-config.js';

const here=path.dirname(fileURLToPath(import.meta.url));
// A stand-in for claude.exe: records its arguments and input, answers like `claude -p --output-format json`.
const FAKE=`import fs from 'node:fs';
const args=process.argv.slice(2);let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
  if(process.env.FAKE_LOG)fs.writeFileSync(process.env.FAKE_LOG,JSON.stringify({args,input,cwd:process.cwd()}));
  const mode=process.env.FAKE_MODE||'ok';
  if(args[0]==='--version'){process.stdout.write('2.1.89 (Claude Code)\\n');return;}
  if(args[0]==='auth'){process.stdout.write(JSON.stringify({loggedIn:mode!=='logged-out',authMethod:'claude.ai',email:'someone@example.com',subscriptionType:'pro'}));return;}
  if(mode==='no-model'&&args[2]!=='haiku'){process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'API Error: 404 not_found_error model: claude-haiku-5-5'}));return;}
  if(mode==='hang'){setTimeout(()=>{},60000);return;}
  if(mode==='revoked'){process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'Failed to authenticate. API Error: 401 OAuth access token has been revoked.'}));return;}
  if(mode==='text'){process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'\`\`\`json\\n{"corrections":[{"id":"a","text":"기준 금리"}]}\\n\`\`\`',modelUsage:{'claude-haiku-5-5':{}}}));return;}
  process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'',structured_output:{corrections:[{id:'a',text:'기준 금리를 올렸습니다'}]},usage:{input_tokens:10,cache_read_input_tokens:5,output_tokens:7},modelUsage:{'claude-haiku-5-5':{costUSD:0}}}));
});`;
async function fakeClaude(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'onsori-fake-claude-'));const script=path.join(dir,'claude.mjs');await fs.writeFile(script,FAKE);
  return {dir,config:{command:process.execPath,prefixArgs:[script]},log:path.join(dir,'log.json')};
}
const lines=[{id:'a',text:'기준 금니를 올렸습니다'}];

test('native messaging frames round-trip, including Korean text',async()=>{
  const stream=new PassThrough(),message={type:'correct',payload:{title:'경제 뉴스',lines}};
  const reading=readMessage(stream);const bytes=frame(message);stream.write(bytes.subarray(0,3));stream.write(bytes.subarray(3));
  assert.deepEqual(await reading,message);assert.equal(bytes.readUInt32LE(0),Buffer.byteLength(JSON.stringify(message)));
  const empty=new PassThrough(),pending=readMessage(empty);empty.end();await assert.rejects(pending,/no message/);
});
test('the bridge runs only Claude Haiku in print mode with tools, hooks, MCP and sessions off',async()=>{
  const fake=await fakeClaude();process.env.FAKE_LOG=fake.log;process.env.FAKE_MODE='ok';
  try{
    const reply=await handle({type:'correct',payload:{title:'경제 뉴스',context:['앞 대사'],lines:[...lines,{id:42,text:'버림'}],system:'다른 지시',tools:'Bash'}},fake.config);
    assert.deepEqual(reply,{ok:true,corrections:[{id:'a',text:'기준 금리를 올렸습니다'}],model:'claude-haiku-5-5',usage:{input_tokens:15,output_tokens:7}});
    const {args,input,cwd}=JSON.parse(await fs.readFile(fake.log,'utf8'));
    assert.deepEqual(args,correctionArgs());
    for(const [flag,value] of [['--model','claude-haiku-5-5'],['--tools',''],['--setting-sources',''],['--output-format','json'],['--system-prompt',CORRECTION_SYSTEM]])assert.equal(args[args.indexOf(flag)+1],value,flag);
    for(const flag of ['-p','--strict-mcp-config','--no-session-persistence','--json-schema'])assert.ok(args.includes(flag),flag);
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings')+1]),{disableAllHooks:true});
    assert.deepEqual(JSON.parse(input),{title:'경제 뉴스',context:['앞 대사'],lines});
    assert.equal(path.basename(cwd),'work');
    assert.deepEqual(await handle({type:'correct',payload:{lines:[]}},fake.config),{ok:true,corrections:[],model:null,usage:null});
    process.env.FAKE_MODE='text';assert.deepEqual((await handle({type:'correct',payload:{lines}},fake.config)).corrections,[{id:'a',text:'기준 금리'}]);
    process.env.FAKE_MODE='revoked';assert.equal((await handle({type:'correct',payload:{lines}},fake.config)).code,'cli_auth');
    // A CLI that does not know the full model name is retried once with the "haiku" alias.
    process.env.FAKE_MODE='no-model';const retried=await handle({type:'correct',payload:{lines}},fake.config);assert.equal(retried.ok,true);
    assert.equal(JSON.parse(await fs.readFile(fake.log,'utf8')).args[2],'haiku');
  }finally{delete process.env.FAKE_LOG;delete process.env.FAKE_MODE;}
});
test('status reports version and sign-in without the account e-mail; failures are classified',async()=>{
  const fake=await fakeClaude();
  const status=await handle({type:'status'},fake.config);assert.deepEqual(status,{ok:true,version:'2.1.89 (Claude Code)',loggedIn:true,authMethod:'claude.ai',subscription:'pro'});
  process.env.FAKE_MODE='logged-out';try{assert.equal((await handle({type:'status'},fake.config)).loggedIn,false);}finally{delete process.env.FAKE_MODE;}
  assert.equal((await handle({type:'status'},{command:path.join(fake.dir,'missing.exe'),prefixArgs:[]})).code,'cli_missing');
  assert.equal((await handle({type:'correct',payload:{lines}},null)).code,'cli_missing');
  assert.equal((await handle({type:'shell',command:'dir'},fake.config)).code,'unknown_request');
  assert.equal(parseResult('not json').code,'invalid_output');assert.equal(parseResult(JSON.stringify({type:'result',subtype:'success',result:'no json here'})).code,'invalid_output');
  assert.equal(parseResult(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true,result:'usage limit reached'})).code,'rate_limited');
});
test('a hung Claude Code process is stopped and the minute keeps its raw text',async()=>{
  const fake=await fakeClaude();process.env.FAKE_MODE='hang';process.env.ONSORI_BRIDGE_TIMEOUT_MS='800';
  try{const {handle:timed}=await import(`./onsori-claude-bridge.mjs?timeout=${Date.now()}`);assert.equal((await timed({type:'correct',payload:{lines}},fake.config)).code,'timeout');}
  finally{delete process.env.FAKE_MODE;delete process.env.ONSORI_BRIDGE_TIMEOUT_MS;}
});
test('the installed bridge answers Chrome over stdin/stdout as a separate process',async()=>{
  const fake=await fakeClaude(),target=path.join(fake.dir,'installed');
  const env={...process.env,ONSORI_CLAUDE:path.join(fake.dir,'claude.exe')};await fs.writeFile(env.ONSORI_CLAUDE,'');
  const previous=process.env.ONSORI_CLAUDE;process.env.ONSORI_CLAUDE=env.ONSORI_CLAUDE;
  try{
    const result=await install(['--target',target,'--no-registry','--id','abcdefghijklmnopabcdefghijklmnop'],{log(){}});
    const manifest=JSON.parse(await fs.readFile(result.manifestPath,'utf8'));
    assert.equal(manifest.name,'com.onsori.claude_bridge');assert.equal(manifest.type,'stdio');assert.ok(manifest.path.endsWith('onsori-claude-bridge.cmd'));
    assert.ok(manifest.allowed_origins.includes(`chrome-extension://${WEB_STORE_ID}/`));assert.ok(manifest.allowed_origins.includes('chrome-extension://abcdefghijklmnopabcdefghijklmnop/'));
    assert.ok(manifest.allowed_origins.includes(`chrome-extension://${unpackedExtensionId(path.join(here,'..','extension'))}/`));
    const again=await install(['--target',target,'--no-registry'],{log(){}});assert.ok(again.origins.includes('chrome-extension://abcdefghijklmnopabcdefghijklmnop/'),'earlier IDs are kept');
    assert.deepEqual(await loadConfig(target),{command:env.ONSORI_CLAUDE,prefixArgs:[]});
    await assert.rejects(install(['--target',target,'--no-registry','--id','NOT-AN-ID'],{log(){}}),/형식/);
    // Point the installed copy at the fake CLI and talk to it exactly like Chrome does.
    await fs.writeFile(path.join(target,'config.json'),JSON.stringify(fake.config));
    const child=spawn(process.execPath,[path.join(target,'onsori-claude-bridge.mjs')],{stdio:['pipe','pipe','inherit']});
    const chunks=[];child.stdout.on('data',d=>chunks.push(d));child.stdin.end(frame({type:'correct',payload:{title:'t',lines}}));
    await new Promise(resolve=>child.on('close',resolve));
    const out=Buffer.concat(chunks);assert.equal(out.readUInt32LE(0),out.length-4);assert.equal(JSON.parse(out.subarray(4).toString('utf8')).corrections[0].text,'기준 금리를 올렸습니다');
    await install(['--target',target,'--no-registry','--uninstall'],{log(){}});await assert.rejects(fs.access(target));
  }finally{if(previous===undefined)delete process.env.ONSORI_CLAUDE;else process.env.ONSORI_CLAUDE=previous;}
});
test('unpacked extension IDs follow Chrome: UTF-16 path with an upper-case drive letter',()=>{
  const folder='C:\\Users\\someone\\onsori\\extension';
  assert.match(unpackedExtensionId(folder,'win32'),/^[a-p]{32}$/);
  assert.equal(unpackedExtensionId('c'+folder.slice(1),'win32'),unpackedExtensionId(folder,'win32'));
  assert.notEqual(unpackedExtensionId(folder,'win32'),unpackedExtensionId(folder+'2','win32'));
  assert.equal(findClaude({ONSORI_CLAUDE:'X:\\claude.exe'},file=>file==='X:\\claude.exe').command,'X:\\claude.exe');
});
test('the installer finds 온소리 extensions already loaded in Chrome profiles by manifest name only',async()=>{
  const {detectInstalledIds}=await import('./install.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'onsori-chrome-')),ours=path.join(root,'onsori-ext'),other=path.join(root,'other-ext');
  await fs.mkdir(ours);await fs.mkdir(other);await fs.writeFile(path.join(ours,'manifest.json'),JSON.stringify({name:'온소리 자막 in YouTube'}));await fs.writeFile(path.join(other,'manifest.json'),JSON.stringify({name:'Other'}));
  const profile=path.join(root,'User Data','Default');await fs.mkdir(profile,{recursive:true});
  await fs.writeFile(path.join(profile,'Secure Preferences'),JSON.stringify({extensions:{settings:{aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:{path:ours},bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:{path:other},'not-an-id':{path:ours}}}}));
  await fs.mkdir(path.join(root,'User Data','Profile 2'));await fs.writeFile(path.join(root,'User Data','Profile 2','Preferences'),'{broken');
  assert.deepEqual(await detectInstalledIds(path.join(root,'User Data')),['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  assert.deepEqual(await detectInstalledIds(path.join(root,'missing')),[]);
});
