"""Local PaddleOCR evidence. Run in a child process to isolate native runtimes."""
from __future__ import annotations
import base64
import io
import json
import os
from pathlib import Path
import sys


def stable_references(observations, video_id):
    """Require repeated, high-confidence exact text; never guess a missing glyph."""
    from .speech_reference import normalized
    groups = []
    for time, text, confidence in sorted(observations):
        text = ' '.join(text.split())
        if confidence < .94 or len(normalized(text)) < 4 or len(text)>500:
            continue
        previous = groups[-1] if groups else None
        if previous and normalized(previous['text']) == normalized(text) and 0 < time-previous['last'] <= 1.1:
            previous['last'] = time
            previous['count'] += 1
            if confidence > previous['confidence']:
                previous['text'], previous['confidence'] = text, confidence
        else:
            groups.append(dict(start=time,last=time,text=text,count=1,confidence=confidence))
    return [dict(video_id=video_id,start=max(0,g['start']-.25),end=g['last']+.25,
                 text=g['text'],source='youtube-screen-ocr') for g in groups
            if g['count']>=2 and g['last']-g['start']>=.2 and g['last']-g['start']<15]


def run(request_path, output_path):
    import av
    import numpy as np
    from PIL import Image
    from huggingface_hub import snapshot_download
    os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK','True')
    os.environ.setdefault('PADDLE_PDX_CACHE_HOME',str(Path('models/paddlex').resolve()))
    from paddleocr import PaddleOCR
    request=json.loads(Path(request_path).read_text(encoding='utf-8'))
    # Relative ASCII paths avoid Paddle's Windows Unicode filename limitation.
    names=['PP-OCRv5_mobile_det','korean_PP-OCRv5_mobile_rec']
    dirs=[f'models/paddlex/official_models/{n}' for n in names]
    for name, directory in zip(names,dirs):
        if not (Path(directory)/'inference.pdiparams').is_file():
            snapshot_download('PaddlePaddle/'+name,local_dir=directory)
    ocr=PaddleOCR(use_doc_orientation_classify=False,use_doc_unwarping=False,
        use_textline_orientation=False,text_detection_model_name=names[0],
        text_detection_model_dir=dirs[0],text_recognition_model_name=names[1],
        text_recognition_model_dir=dirs[1],enable_mkldnn=False,cpu_threads=4)
    windows=request['windows']
    def relevant(t):return any(a-.8<=t<=b+.8 for a,b in windows)
    def frames():
        if request.get('frames'):
            for frame in request['frames']:
                if frame['video_id']!=request['video_id'] or not relevant(frame['time']):continue
                raw=base64.b64decode(frame['jpeg'].split(',',1)[1],validate=True)
                with Image.open(io.BytesIO(raw)) as im:
                    if im.width>1280 or im.height>1280:raise ValueError('OCR image dimensions exceeded')
                    yield frame['time'],np.asarray(im.convert('RGB'))[:,:,::-1].copy()
        elif request.get('video'):
            with av.open(request['video']) as container:
                if not container.streams.video:return
                last=-1.0
                for frame in container.decode(video=0):
                    t=float(frame.time or 0)+request.get('offset',0)
                    if t>request['end']+.8:break
                    if t-last<.24 or not relevant(t):continue
                    last=t
                    im=frame.to_image();im.thumbnail((1280,1280))
                    a=np.asarray(im);yield t,a[int(len(a)*.60):,:,::-1].copy()
    observations=[]
    for i,(time,frame) in enumerate(frames()):
        if i>=2400:break
        for result in ocr.predict(frame):
            rows=[(box,text,float(score)) for box,text,score in zip(result['rec_boxes'],result['rec_texts'],result['rec_scores']) if score>=.94]
            # Only central subtitle rows, not corner logos; join a two-line subtitle.
            rows=[r for r in rows if r[0][0]<frame.shape[1]*.75 and r[0][2]>frame.shape[1]*.25]
            rows.sort(key=lambda r:(round(float(r[0][1])/20),r[0][0]))
            if rows:observations.append((time,' '.join(r[1] for r in rows),min(r[2] for r in rows)))
    result={'references':stable_references(observations,request['video_id']),
            'observations':observations,'model':'korean_PP-OCRv5_mobile_rec'}
    Path(output_path).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')


if __name__=='__main__':run(sys.argv[1],sys.argv[2])
