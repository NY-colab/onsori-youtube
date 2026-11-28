// QA for hand-correction mode on a real YouTube page: seed captions, open the on-video editor,
// change a line, check the stored edit and the caption shown over the video.
// Usage: ONSORI_CHROMIUM_PATH=... node browser-build/qa-edit-mode.mjs <out-dir>
import {chromium} from 'playwright';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const out=process.argv[2]||tmpdir(),ext=fileURLToPath(new URL('../extension',import.meta.url)),VID='jpQQ9WveNZA';
const ctx=await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(),'onsori-edit-')),{headless:false,executablePath:process.env.ONSORI_CHROMIUM_PATH||undefined,viewport:{width:1400,height:900},args:['--headless=new',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--mute-audio','--autoplay-policy=no-user-gesture-required']});
const sw=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');const id=new URL(sw.url()).host;
const cue=(i,start,end,text,kind='speech')=>({id:`s${i}`,start,end,text,kind,dbfs:-20,relative_db:0,scale:1,confidence:.9,source:'qa',review_required:false});
const document={schema_version:'1.0',video_id:VID,title:'QA',duration:879,cues:[cue(1,4,9,'금니가 올랐습니다'),cue(2,9,12,'문 닫히는 소리','sound'),cue(3,12,16,'셋째 대사')],warnings:[],metadata:{audio_analyzed:true}};
const extPage=await ctx.newPage();await extPage.goto(`chrome-extension://${id}/help.html`);
await extPage.evaluate(([key,entry])=>chrome.storage.local.set({settings:{editMode:true,autoAnalyze:false},[key]:entry}),[`cc:${VID}`,{ready:true,displayVersion:2,origin:'import',document,savedAt:Date.now()}]);
const page=await ctx.newPage();const result={};
await page.goto(`https://www.youtube.com/watch?v=${VID}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&Number.isFinite(v.duration)&&v.duration>800&&!document.querySelector('.ad-showing');},null,{timeout:90000});
await page.evaluate(()=>{const v=document.querySelector('video');v.pause();v.currentTime=6;});
const row=page.locator('onsori-captions .cue.speech');await row.waitFor({timeout:20000});
result.pillVisible=await page.locator('onsori-captions .edit-pill').isVisible();
await page.waitForTimeout(1500);
result.layout=await page.evaluate(()=>{const h=document.querySelector('onsori-captions'),box=h.shadowRoot.querySelector('.captions'),v=document.querySelector('video'),r=v.getBoundingClientRect(),hr=h.getBoundingClientRect();return {boxTop:box.style.top,boxLeft:box.style.left,video:[r.top,r.height,v.videoWidth,v.videoHeight],host:[hr.top,hr.height]};});
result.rowCursor=await row.evaluate(el=>getComputedStyle(el).cursor);
await page.screenshot({path:join(out,'edit-1-mode.png')});
await row.click();
const editor=page.locator('onsori-captions .editor');await editor.waitFor({state:'visible',timeout:5000});
result.paused=await page.evaluate(()=>document.querySelector('video').paused);
const box=editor.locator('textarea').first();result.before=await box.inputValue();
await box.fill('금리가 올랐습니다');await page.screenshot({path:join(out,'edit-2-editor.png')});await box.press('Enter');
await page.waitForTimeout(500);
result.note=await editor.locator('.note').first().textContent();
result.stored=await extPage.evaluate(key=>chrome.storage.local.get(key).then(r=>r[key]),`ed:${VID}`);
result.shown=await row.textContent();
result.stillPaused=await page.evaluate(()=>document.querySelector('video').paused);
await editor.locator('[data-act=next]').click();await page.waitForTimeout(300);
result.nextValue=await editor.locator('textarea').first().inputValue();result.time=await page.evaluate(()=>document.querySelector('video').currentTime);
await page.screenshot({path:join(out,'edit-3-next.png')});
await page.keyboard.press('Escape');await page.waitForTimeout(200);result.closed=!(await editor.isVisible());
await page.evaluate(()=>{document.querySelector('video').currentTime=6;});await page.waitForTimeout(400);
result.afterClose=await page.locator('onsori-captions .cue.speech').textContent();
await page.screenshot({path:join(out,'edit-4-result.png')});
// The panel shows the switch, the number of edits and the reset link.
await page.reload({waitUntil:'domcontentloaded'});
const toggle=page.locator('#editMode');await toggle.waitFor({state:'attached',timeout:30000});
await page.locator('#editSection').waitFor({state:'visible',timeout:30000}).catch(()=>{});
result.panel={visible:await page.locator('#editSection').isVisible(),checked:await toggle.isChecked(),count:await page.locator('#editCount').textContent(),reset:await page.locator('#resetEdits').isVisible()};
await page.locator('#editSection').scrollIntoViewIfNeeded().catch(()=>{});await page.locator('#editSection').screenshot({path:join(out,'edit-5-panel.png')}).catch(()=>{});
await toggle.uncheck();await page.waitForTimeout(600);
result.pillAfterOff=await page.locator('onsori-captions .edit-pill').isVisible();
console.log(JSON.stringify(result,null,1));
await ctx.close();
