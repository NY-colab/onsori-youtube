"""Prepare copy-ready listing helper next to the store ZIP; no account access."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / 'onsori-webstore'
OUT.mkdir(exist_ok=True)
listing = json.loads((ROOT/'docs/webstore-listing.json').read_text('utf-8'))
shutil.copy2(ROOT/'docs/webstore-listing.json',OUT/'webstore-listing.json')
shutil.copy2(ROOT/'docs/privacy-browser.md',OUT/'privacy-browser.md')
shutil.copy2(ROOT/'docs/webstore-submission.md',OUT/'webstore-submission.md')
shutil.copy2(ROOT/'extension/icons/icon-128.png',OUT/'store-icon-128.png')
fields = [('확장 이름',listing['name']),('간략한 설명',listing['summary']),('상세 설명',listing['description']),
          ('단일 목적',listing['single_purpose']),('개인정보처리방침 URL',listing['privacy_policy_url']),
          ('홈페이지 URL',listing['homepage_url']),('지원 URL',listing['support_url'])]
fields += [(key+' 권한 사유',value) for key,value in listing['permissions'].items()]
fields += [('원격 코드 설명 — 원격 코드 없음',listing['remote_code_explanation']),
           ('데이터 처리 설명',listing['data_disclosures']['explanation']),('심사자 테스트 안내',listing['reviewer_instructions'])]
page = '''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>온소리 웹스토어 등록 도우미</title>
<style>body{font-family:"Malgun Gothic",sans-serif;max-width:960px;margin:32px auto;padding:0 20px;background:#15131e;color:#eee}h1{font-size:28px}p,li{line-height:1.8;color:#c8c1d5}a{color:#a4efcf}section{border:1px solid #463c53;border-radius:12px;padding:18px;margin:14px 0}h2{font-size:17px;margin:0 0 12px}textarea{box-sizing:border-box;width:100%;min-height:85px;padding:12px;background:#24202e;color:#eee;border:1px solid #655673;border-radius:6px;font:13px/1.7 sans-serif}button{margin-top:10px;background:#a4efcf;color:#173b2e;border:0;border-radius:7px;padding:10px 18px;font-weight:bold;cursor:pointer}.tag{color:#f6cc7a}img{max-width:100%;height:auto;border-radius:12px}.assets{display:flex;flex-wrap:wrap;gap:18px}small{display:block;margin:10px 0;color:#bbb}</style>
<h1>온소리 웹스토어 등록 도우미</h1><p class="tag">0.3.0 · 아직 웹스토어에 제출되지 않았습니다.</p>
<ol><li><a href="https://chrome.google.com/webstore/devconsole" target="_blank" rel="noopener">개발자 대시보드</a>의 <b>새 항목</b>에서 아래 확장 ZIP을 선택하세요.</li><li>이미지 파일을 올리고, 아래 항목의 <b>복사</b> 버튼으로 등록정보를 입력하세요.</li><li>계정 정보와 배포 범위를 확인한 뒤 <b>심사에 제출</b>합니다. 제출 이후에도 Google의 심사·승인이 필요합니다.</li></ol>
<div class="assets"><a href="OnSori-Chrome-WebStore-0.3.0.zip" download>업로드할 확장 ZIP</a><a href="store-icon-128.png" download>128px 아이콘</a><a href="screenshot-01-start.png" download>이전 버전 참고 이미지 (교체 필요)</a></div>
<p>기본 언어: 한국어. 접근성 용도에 맞는 분류와 무료 배포를 선택하세요. 개인정보 항목은 <b>웹사이트 콘텐츠·웹 기록·사용자 활동</b>에 해당하는 현재 영상 정보와 로컬 분석만 공개합니다. 원격 실행 코드 없음. 데이터 판매·단일 목적 외 사용·신용 평가 사용 없음. 실제 대시보드의 각 항목 설명과 대조해 입력하세요.</p>
<div id="fields"></div><h2>이전 버전 시작 화면 · 제출 전 교체 필요</h2><img src="screenshot-01-start.png" alt="이전 버전 온소리 시작 안내"><p>이 파일은 등록을 돕는 로컬 자료이며 로그인·업로드·제출을 대신 실행하지 않습니다. 계정 인증과 게시자 정보는 계정 소유자의 실제 정보로 입력하세요.</p>
<script>const fields=__DATA__;for(const [title,value] of fields){const section=document.createElement('section'),h=document.createElement('h2'),area=document.createElement('textarea'),button=document.createElement('button'),status=document.createElement('small');h.textContent=title;area.value=value;area.readOnly=true;area.rows=value.length>800?12:3;button.textContent='복사';button.onclick=async()=>{try{await navigator.clipboard.writeText(value);status.textContent='복사했습니다. 대시보드에 붙여넣으세요.';}catch{area.focus();area.select();status.textContent=document.execCommand('copy')?'복사했습니다.':'선택된 내용을 Ctrl+C로 복사하세요.';}};section.append(h,area,button,status);document.querySelector('#fields').append(section);}</script></html>'''
page=page.replace('__DATA__',json.dumps(fields,ensure_ascii=False).replace('<','\\u003c'))
(OUT/'등록도우미.html').write_text(page,encoding='utf-8')
print(json.dumps({'output':str(OUT),'fields':len(fields)},ensure_ascii=False))
