"""Real loopback HTTP smoke test; synthetic audio and synthetic ASR only."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]


def test_real_http_gateway_to_node_client_to_existing_caption_schema(tmp_path):
    node = shutil.which('node')
    assert node, 'Node 22+ is required for the operator client integration test'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    audio = tmp_path / 'synthetic-silence.wav'
    with wave.open(str(audio), 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(b'\x00\x00' * 16000)
    env = {**os.environ, 'ONSORI_PROVIDER':'mock', 'ONSORI_ALLOW_PAID':'false',
           'ONSORI_DATA_DIR':str(tmp_path / 'gateway'),
           'ONSORI_API_TOKEN':'synthetic-api-only-' * 3,
           'ONSORI_METRICS_TOKEN':'synthetic-metrics-only-' * 3,
           'DEEPINFRA_API_KEY':'', 'ONSORI_GATEWAY_URL':f'http://127.0.0.1:{port}'}
    process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'cloud_gateway.app:app',
                                '--host','127.0.0.1','--port',str(port),'--no-access-log'],
                               cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        ready = False
        for _ in range(80):
            if process.poll() is not None:
                raise AssertionError('Local mock gateway failed to start')
            try:
                with urllib.request.urlopen(env['ONSORI_GATEWAY_URL']+'/healthz', timeout=.2) as response:
                    ready = response.status == 200
                if ready: break
            except (OSError, TimeoutError): time.sleep(.1)
        assert ready
        output = tmp_path / 'mock-captions.json'
        result = subprocess.run([node, 'scripts/cloud_pilot.mjs', '--audio', str(audio), '--out', str(output),
                                 '--video-id', '-wbEQJ_ZXyk', '--consent', '--mock', '--loopback'],
                                cwd=ROOT, env=env, text=True, encoding='utf-8', capture_output=True, timeout=30)
        assert result.returncode == 0, result.stderr
        doc = json.loads(output.read_text(encoding='utf-8'))
        assert doc['metadata']['synthetic'] is True
        assert doc['video_id'] == '-wbEQJ_ZXyk'
        assert doc['duration'] == 1
        assert doc['cues'][0]['scale'] == 1
        assert doc['cues'][0]['review_required'] is True
        assert 'MOCK' in doc['cues'][0]['text']
        assert not list((tmp_path/'gateway').glob('*.wav'))
        request = urllib.request.Request(env['ONSORI_GATEWAY_URL']+'/metrics',
                                         headers={'Authorization':'Bearer '+env['ONSORI_METRICS_TOKEN']})
        with urllib.request.urlopen(request) as response:
            metrics = response.read().decode()
        assert 'onsori_jobs_total{status="done"} 1' in metrics
        assert 'SYNTHETIC' not in metrics
    finally:
        process.terminate()
        try: process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.communicate(timeout=5)
