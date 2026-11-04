// Operator pilot only. Never bundle this file or the operator token in the extension.
import {readFile, writeFile, access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {createCloudClient, completedDocument} from '../integrations/client/cloud-client.mjs';

const args = process.argv.slice(2);
const flags = new Set(['--consent', '--mock', '--paid', '--loopback']);
const named = new Set(['--audio', '--out', '--video-id', '--title', '--key', '--job']);
const options = {};
try {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flags.has(flag)) options[flag] = true;
    else if (named.has(flag) && args[i + 1] && !args[i + 1].startsWith('--')) options[flag] = args[++i];
    else throw new Error('지원하지 않는 인자입니다. integrations/client/README.ko.md를 참조하세요.');
  }
  if (!options['--out'] || (!options['--job'] && !options['--audio'])) throw new Error('--audio 또는 --job과 --out이 필요합니다.');
  if (options['--mock'] && options['--paid']) throw new Error('--mock과 --paid는 함께 사용할 수 없습니다.');
  try { await access(options['--out']); throw new Error('출력 파일이 이미 있습니다. 다른 경로를 지정하세요.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const client = createCloudClient({baseUrl: process.env.ONSORI_GATEWAY_URL, token: process.env.ONSORI_API_TOKEN,
    allowLoopback: options['--loopback'] === true});
  let job;
  if (options['--job']) job = await client.get(options['--job']);
  else {
    const key = options['--key'] || randomUUID();
    console.log(`Idempotency-Key: ${key}`); // Safe recovery identifier, not a credential.
    job = await client.submit({audio: new Blob([await readFile(options['--audio'])], {type: 'audio/wav'}),
      key, videoId: options['--video-id'] || null, title: options['--title'] || 'OnSori pilot',
      consent: options['--consent'] === true, allowMock: options['--mock'] === true, allowPaid: options['--paid'] === true});
  }
  console.log(`작업 ID: ${job.id}`);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (['queued', 'running'].includes(job.status)) {
    if (Date.now() > deadline) throw new Error(`조회 시간을 초과했습니다. 재업로드하지 말고 --job ${job.id}로 이어서 확인하세요.`);
    await sleep(1500); job = await client.get(job.id);
  }
  const doc = completedDocument(job, {videoId: options['--video-id'] || null, allowMock: options['--mock'] === true});
  await writeFile(options['--out'], JSON.stringify(doc, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(doc.metadata.synthetic ? '모의 결과 저장 완료: 인식 정확도 증거가 아닙니다.' : '대사 검토용 JSON 저장 완료. 검토 후 온소리에서 가져오세요.');
} catch (error) {
  // Messages are controlled locally; do not log request headers or provider body.
  console.error(error instanceof Error ? error.message : '작업 실패'); process.exitCode = 1;
}
