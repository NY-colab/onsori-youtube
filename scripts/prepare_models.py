"""Download and load the default models before reporting installation ready."""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))
from server import pipeline

def main():
    from faster_whisper import WhisperModel
    from huggingface_hub import snapshot_download
    print('PROGRESS:65:대사 인식 모델 준비 중', flush=True)
    model = WhisperModel('base', device='cpu', compute_type='int8',
                         download_root=str(pipeline.MODEL_DIR / 'whisper'),
                         revision=pipeline.WHISPER_BASE_REVISION)
    del model
    print('PROGRESS:75:음악·효과음 모델 준비 중', flush=True)
    pipeline.load_ast(lambda *args: None)
    print('PROGRESS:85:한국어 화면 자막 인식 모델 준비 중', flush=True)
    os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
    os.environ['PADDLE_PDX_CACHE_HOME'] = str(ROOT / 'models/paddlex')
    from paddleocr import PaddleOCR
    names = ['PP-OCRv5_mobile_det', 'korean_PP-OCRv5_mobile_rec']
    directories = ['models/paddlex/official_models/' + name for name in names]
    for name, directory in zip(names, directories):
        snapshot_download('PaddlePaddle/' + name, local_dir=directory)
    PaddleOCR(use_doc_orientation_classify=False, use_doc_unwarping=False,
              use_textline_orientation=False, text_detection_model_name=names[0],
              text_detection_model_dir=directories[0], text_recognition_model_name=names[1],
              text_recognition_model_dir=directories[1], enable_mkldnn=False, cpu_threads=4)
    from fastapi.testclient import TestClient
    from server.app import app
    with TestClient(app) as client:
        result = client.get('/api/health', headers={'X-OnSori-Client': 'onsori-local-v1'})
        assert result.status_code == 200 and result.json()['status'] == 'ok'
    print('PROGRESS:95:분석 모델과 서버 검사 완료', flush=True)

if __name__ == '__main__':
    main()
