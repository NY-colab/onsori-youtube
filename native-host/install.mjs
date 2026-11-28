// Installs (or removes) the 「온소리 자막 in YouTube」 Claude Code bridge for the current
// Windows user: copies the bridge to %LOCALAPPDATA%\OnSori\claude-bridge, writes its Chrome
// native messaging manifest and registers it under HKCU (no administrator rights).
//
//   node native-host/install.mjs [--id <extension id>]... [--extension-path <folder>]...
//   node native-host/install.mjs --uninstall
//
// Allowed callers: the Chrome Web Store build, the unpacked extension in this repository, every
// 온소리 extension already loaded in this PC's Chrome and every --id / --extension-path given.
// IDs registered earlier are kept.
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BRIDGE_HOST} from '../extension/ai-config.js';

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'..');
export const WEB_STORE_ID='faoookmndmicfapakdnelnepfdcphgkp';
const REGISTRY=[`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BRIDGE_HOST}`];

// Chrome's ID for an unpacked extension: SHA-256 of the absolute folder path (UTF-16LE on
// Windows, drive letter upper-cased), first 16 bytes, hex digits mapped to a–p.
export function unpackedExtensionId(folder,platform=process.platform){
  let value=path.resolve(folder);if(platform==='win32'&&/^[a-z]:/.test(value))value=value[0].toUpperCase()+value.slice(1);
  const bytes=platform==='win32'?Buffer.from(value,'utf16le'):Buffer.from(value,'utf8');
  return createHash('sha256').update(bytes).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
}
// The 온소리 extensions already loaded in this PC's Chrome profiles, so nothing has to be
// typed in. Reads only extensions.settings[id].path from each profile's preference files and
// the manifest name at that path; no history, cookies or other browser data.
export async function detectInstalledIds(userData=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Google','Chrome','User Data')){
  const ids=new Set();let profiles=[];
  try{profiles=(await fs.readdir(userData,{withFileTypes:true})).filter(e=>e.isDirectory()&&(e.name==='Default'||/^Profile \d+$/.test(e.name))).map(e=>path.join(userData,e.name));}catch{return [];}
  for(const profile of profiles)for(const file of ['Secure Preferences','Preferences']){
    let settings={};try{settings=JSON.parse(await fs.readFile(path.join(profile,file),'utf8'))?.extensions?.settings||{};}catch{continue;}
    for(const [id,entry] of Object.entries(settings)){
      if(!/^[a-p]{32}$/.test(id)||typeof entry?.path!=='string')continue;
      const folder=path.isAbsolute(entry.path)?entry.path:path.join(profile,'Extensions',entry.path);
      try{const manifest=JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8'));if(manifest.name==='온소리 자막 in YouTube')ids.add(id);}catch{}
    }
  }
  return [...ids];
}
export function findClaude(env=process.env,exists=existsSync){
  const candidates=[env.ONSORI_CLAUDE,path.join(env.USERPROFILE||os.homedir(),'.local','bin','claude.exe')].filter(Boolean);
  for(const file of candidates)if(exists(file))return {command:file,prefixArgs:[]};
  try{const found=execFileSync('where.exe',['claude.exe'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).split(/\r?\n/).find(Boolean);if(found&&exists(found.trim()))return {command:found.trim(),prefixArgs:[]};}catch{}
  // npm installation: run its JavaScript entry with this Node, never through a .cmd shell.
  const npmCli=path.join(env.APPDATA||'','npm','node_modules','@anthropic-ai','claude-code','cli.js');
  if(exists(npmCli))return {command:process.execPath,prefixArgs:[npmCli]};
  return null;
}
function parseArgs(argv){
  const options={ids:[],paths:[],uninstall:false,registry:true,detect:true,target:path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'OnSori','claude-bridge')};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i],next=()=>{const v=argv[++i];if(!v)throw new Error(`${arg} 다음에 값을 적어 주세요.`);return v;};
    if(arg==='--id')options.ids.push(next());else if(arg==='--extension-path')options.paths.push(next());
    else if(arg==='--uninstall')options.uninstall=true;else if(arg==='--no-registry')options.registry=false;else if(arg==='--no-detect')options.detect=false;else if(arg==='--target')options.target=path.resolve(next());
    else if(/^[a-p]{32}$/.test(arg))options.ids.push(arg);else throw new Error(`알 수 없는 옵션입니다: ${arg}`);
  }
  for(const id of options.ids)if(!/^[a-p]{32}$/.test(id))throw new Error(`확장 ID 형식이 올바르지 않습니다: ${id}`);
  return options;
}
export async function install(argv=process.argv.slice(2),{log=console.log}={}){
  const options=parseArgs(argv),manifestPath=path.join(options.target,`${BRIDGE_HOST}.json`);
  if(options.uninstall){
    if(options.registry)for(const key of REGISTRY){try{execFileSync('reg',['delete',key,'/f'],{stdio:'ignore'});}catch{}}
    await fs.rm(options.target,{recursive:true,force:true});log('Claude Code 연결 프로그램을 제거했습니다.');return {removed:true};
  }
  const claude=findClaude();if(!claude)throw new Error('Claude Code(claude.exe)를 찾지 못했습니다. Claude Code를 설치하거나 ONSORI_CLAUDE 환경 변수에 claude.exe 경로를 지정해 주세요.');
  let previous=[];try{previous=JSON.parse(await fs.readFile(manifestPath,'utf8')).allowed_origins||[];}catch{}
  const detected=options.detect?await detectInstalledIds():[];
  const ids=[WEB_STORE_ID,unpackedExtensionId(path.join(repo,'extension')),...detected,...options.paths.map(p=>unpackedExtensionId(p)),...options.ids];
  const origins=[...new Set([...previous.filter(o=>/^chrome-extension:\/\/[a-p]{32}\/$/.test(o)),...ids.map(id=>`chrome-extension://${id}/`)])];
  await fs.mkdir(options.target,{recursive:true});
  await fs.copyFile(path.join(here,'onsori-claude-bridge.mjs'),path.join(options.target,'onsori-claude-bridge.mjs'));
  await fs.copyFile(path.join(repo,'extension','ai-config.js'),path.join(options.target,'ai-config.js'));
  await fs.writeFile(path.join(options.target,'package.json'),JSON.stringify({type:'module',private:true})+'\n');
  await fs.writeFile(path.join(options.target,'config.json'),JSON.stringify(claude,null,2)+'\n');
  const launcher=path.join(options.target,'onsori-claude-bridge.cmd');
  await fs.writeFile(launcher,`@echo off\r\n"${process.execPath}" "%~dp0onsori-claude-bridge.mjs" %*\r\n`);
  await fs.writeFile(manifestPath,JSON.stringify({name:BRIDGE_HOST,description:'온소리 자막 in YouTube · Claude Code caption correction bridge',path:launcher,type:'stdio',allowed_origins:origins},null,2)+'\n');
  if(options.registry)for(const key of REGISTRY)execFileSync('reg',['add',key,'/ve','/t','REG_SZ','/d',manifestPath,'/f'],{stdio:'ignore'});
  log(`Claude Code 연결 프로그램을 설치했습니다.\n- 위치: ${options.target}\n- Claude Code: ${claude.prefixArgs[0]||claude.command}\n- 허용한 확장 ID: ${origins.map(o=>o.slice(19,51)).join(', ')}`);
  return {manifestPath,origins,claude};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  install().catch(error=>{console.error(error.message);process.exitCode=1;});
}
