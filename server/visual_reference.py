"""Bounded local OCR orchestration; failures never fabricate evidence."""
import json
from pathlib import Path
import subprocess
import sys
import time

from . import pipeline
from .speech_reference import Reference, apply_screen_references


def correct_from_screen(doc, options, path, folder, update, cancel):
    if options.language not in ('ko','auto'):
        return doc
    speech=[c for c in doc.cues if c.kind=='speech' and 'whisper' in c.source and not c.speech_correction]
    if not speech:return doc
    frames=[f.model_dump() for f in options.screen_frames]
    video=None;offset=options.start_time
    if not frames:
        import av
        try:
            with av.open(str(path)) as media:
                if media.streams.video:video=str(Path(path).resolve())
        except (OSError,ValueError):pass
        if video is None:
            update(.965,'화면 자막 참조 영상 확인 중')
            video,_=pipeline.download_youtube(options.video_id,folder,cancel,visual=True)
            video=str(video.resolve());offset=0
    request={'video_id':doc.video_id,'windows':[[c.start,c.end] for c in speech],
             'frames':frames,'video':video,'offset':offset,'end':max(c.end for c in speech)}
    request_path=folder/'ocr-request.json';output=folder/'ocr-evidence.json'
    request_path.write_text(json.dumps(request,ensure_ascii=False),encoding='utf-8')
    update(.97,'화면 자막을 읽고 대사와 대조 중')
    with (folder/'ocr.log').open('w',encoding='utf-8') as log:
        process=subprocess.Popen([sys.executable,'-X','utf8','-m','server.screen_ocr',str(request_path.resolve()),str(output.resolve())],
            cwd=pipeline.ROOT,stdout=log,stderr=log,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        started=time.monotonic()
        try:
            while process.poll() is None:
                pipeline.check_cancel(cancel)
                if time.monotonic()-started>600:raise TimeoutError('화면 자막 분석 제한 시간 초과')
                cancel.wait(.25)
        finally:
            if process.poll() is None:process.terminate();process.wait(timeout=10)
    if process.returncode!=0:raise RuntimeError('화면 자막 읽기 실패: ocr.log 참고')
    evidence=json.loads(output.read_text(encoding='utf-8'))
    refs=[Reference(**r) for r in evidence['references']]
    apply_screen_references(doc,refs)
    doc.metadata['screen_correction']['model']=evidence['model']
    return doc
