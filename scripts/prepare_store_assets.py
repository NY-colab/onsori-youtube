"""Prepare copy-ready listing helper next to the store ZIP; no account access."""
from pathlib import Path
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / 'onsori-webstore'
OUT.mkdir(exist_ok=True)
listing = json.loads((ROOT/'docs/webstore-listing.json').read_text('utf-8'))
version = json.loads((ROOT/'extension/manifest.json').read_text('utf-8'))['version']
screenshots = [
    ('screenshot-01-intro.png', '01 서비스 소개'),
    ('screenshot-02-analysis.png', '02 영상 분석'),
    ('screenshot-03-settings.png', '03 자막 크기·위치'),
]
for filename, _ in screenshots:
    shutil.copy2(ROOT/'docs/store-assets'/filename, OUT/filename)
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
<h1>온소리 자막 in YouTube · 스토어 등록자료</h1><p class="tag">__VERSION__ · 새 아이콘·상세 이미지 반영본</p>
<ol><li><a href="https://chrome.google.com/webstore/devconsole" target="_blank" rel="noopener">개발자 대시보드</a>에서 기존 항목을 선택하고 아래 확장 ZIP을 업로드합니다.</li><li>스토어 등록정보의 아이콘을 교체하고, 기존 등록자료와 같은 서비스 소개 → 영상 분석 → 자막 크기·위치 순서로 상세 이미지 3장을 올립니다.<br>마이 AI 랩 원본 파일 기준 (2) → (1) → (3)입니다.</li><li>저장 후 대시보드의 심사·게시 상태를 확인합니다.</li></ol>
<div class="assets"><a href="OnSori-Chrome-WebStore-__VERSION__.zip" download>업로드할 확장 ZIP</a><a href="store-icon-128.png" download>128px 아이콘</a>__IMAGE_LINKS__</div>
<p>기본 언어: 한국어. 접근성 용도에 맞는 분류와 무료 배포를 선택하세요. 개인정보 항목은 <b>웹사이트 콘텐츠·웹 기록·사용자 활동</b>에 해당하는 현재 영상 정보와 로컬 분석만 공개합니다. 원격 실행 코드 없음. 데이터 판매·단일 목적 외 사용·신용 평가 사용 없음. 실제 대시보드의 각 항목 설명과 대조해 입력하세요.</p>
<h2>아이콘 · 128×128</h2><img src="store-icon-128.png" width="128" height="128" alt="헤드폰을 쓴 온소리 자막 in YouTube 캐릭터"><h2>상세 이미지 · 1280×800</h2>__IMAGE_PREVIEWS__<h2>등록 문구</h2><div id="fields"></div>
<script>const fields=__DATA__;for(const [title,value] of fields){const section=document.createElement('section'),h=document.createElement('h2'),area=document.createElement('textarea'),button=document.createElement('button'),status=document.createElement('small');h.textContent=title;area.value=value;area.readOnly=true;area.rows=value.length>800?12:3;button.textContent='복사';button.onclick=async()=>{try{await navigator.clipboard.writeText(value);status.textContent='복사했습니다. 대시보드에 붙여넣으세요.';}catch{area.focus();area.select();status.textContent=document.execCommand('copy')?'복사했습니다.':'선택된 내용을 Ctrl+C로 복사하세요.';}};section.append(h,area,button,status);document.querySelector('#fields').append(section);}</script></html>'''
page=page.replace('__DATA__',json.dumps(fields,ensure_ascii=False).replace('<','\\u003c'))
page=page.replace('__VERSION__',version)
page=page.replace('__IMAGE_LINKS__',''.join(
    f'<a href="{filename}" download>{label}</a>' for filename,label in screenshots))
page=page.replace('__IMAGE_PREVIEWS__',''.join(
    f'<figure style="margin:16px 0 28px"><a href="{filename}" download><img src="{filename}" width="1280" height="800" alt="{label}"></a><figcaption>{label}</figcaption></figure>'
    for filename,label in screenshots))
(OUT/'등록도우미.html').write_text(page,encoding='utf-8')
print(json.dumps({'output':str(OUT),'fields':len(fields)},ensure_ascii=False))
