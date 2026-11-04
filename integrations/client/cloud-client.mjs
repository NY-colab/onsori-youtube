import {validateDocument} from '../../extension/core.js';

const MAX_RESPONSE = 16 * 1024 * 1024;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function createCloudClient({baseUrl, token, allowLoopback = false, fetchImpl = fetch}) {
  const url = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (allowLoopback && loopback && url.protocol === 'http:'))) {
    throw new Error('승인된 HTTPS origin이 필요합니다. 로컬 HTTP는 명시적 테스트 설정만 허용합니다.');
  }
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,}$/.test(token)) throw new Error('운영자 토큰 형식이 올바르지 않습니다.');

  async function request(path, {method = 'GET', body, key, timeoutMs = 15000} = {}) {
    const headers = {Authorization: `Bearer ${token}`};
    if (key) headers['Idempotency-Key'] = key;
    let response;
    try {
      response = await fetchImpl(`${url.origin}${path}`, {
        method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('요청 결과를 확인하지 못했습니다. 자동 재제출하지 않았습니다. 동일 키 또는 작업 ID로 확인하세요.');
    }
    // Do not surface upstream error bodies, which may contain credentials or audio text.
    if (!response.ok) throw new Error(`Gateway HTTP ${response.status}; 자동 재제출하지 않았습니다.`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('서버 응답이 비어 있습니다.');
    const chunks = []; let total = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE) { await reader.cancel(); throw new Error('서버 응답 크기 초과'); }
        chunks.push(value);
      }
      const data = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw new Error('서버 응답을 안전하게 읽지 못했습니다. 자동 재제출하지 않았습니다.');
    }
  }

  function jobPath(id) {
    if (!safeId(id)) throw new Error('잘못된 작업 ID');
    return `/v1/jobs/${id}`;
  }

  return {
    status: () => request('/v1/status'),
    get: id => request(jobPath(id)),
    cancel: id => request(jobPath(id), {method: 'DELETE'}),
    async submit({audio, videoId = null, title = 'OnSori pilot', consent = false, key,
                  allowMock = false, allowPaid = false}) {
      if (consent !== true) throw new Error('오디오 업로드 동의가 필요합니다.');
      if (!(audio instanceof Blob) || audio.size < 44 || audio.size > 40 * 1024 * 1024) throw new Error('40MiB 이하의 WAV 파일이 필요합니다.');
      if (videoId != null && !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('잘못된 YouTube 영상 ID');
      if (typeof title !== 'string' || title.length > 300 || title.includes('\0')) throw new Error('잘못된 제목');
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key ?? '')) throw new Error('고유 Idempotency-Key가 필요합니다.');
      const state = await request('/v1/status');
      if (!state.enabled) throw new Error('서버의 분석 기능이 비활성 상태입니다.');
      if (!(state.provider === 'mock' && allowMock) && !(state.provider === 'deepinfra' && allowPaid)) {
        throw new Error('해당 분석 방식 사용을 명시적으로 선택해야 합니다.');
      }
      const form = new FormData();
      form.set('file', audio, 'audio.wav'); form.set('consent', 'true'); form.set('language', 'ko'); form.set('title', title);
      if (videoId) form.set('video_id', videoId);
      const job = await request('/v1/jobs', {method: 'POST', body: form, key, timeoutMs: 120000});
      if (!safeId(job.id)) throw new Error('응답에 올바른 작업 ID가 없습니다. 동일 키로 상태를 확인하세요.');
      return job;
    },
  };
}

export function completedDocument(job, {videoId = null, allowMock = false} = {}) {
  if (job?.status !== 'done') throw new Error('완료된 작업만 자막으로 가져올 수 있습니다.');
  const doc = validateDocument(job.result);
  if (doc.video_id !== videoId) throw new Error('요청 영상과 자막 영상이 일치하지 않습니다.');
  const metadata = doc.metadata ?? {};
  const synthetic = metadata.synthetic === true || metadata.provider === 'mock' || doc.cues.some(c => c.source === 'mock-synthetic');
  if (synthetic && !allowMock) throw new Error('모의 결과는 실제 자막으로 사용할 수 없습니다.');
  if (metadata.analysis_scope !== 'speech-only' || metadata.review_required !== true ||
      doc.cues.some(c => c.kind !== 'speech' || c.scale !== 1 || c.review_required !== true)) {
    throw new Error('현재 운영자 파일럿의 대사 검토용 결과 규격과 다릅니다.');
  }
  return doc;
}
