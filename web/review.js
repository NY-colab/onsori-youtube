// Review attachments share the document's absolute 0-second timeline.
// A duration mismatch is a warning, never permission to stretch or shift cues.
export function inspectReviewMedia(doc,mediaDuration,currentTime=0){
  const warnings=[];
  if(!doc||!Number.isFinite(mediaDuration)||mediaDuration<=0)return {warnings,time:Math.max(0,currentTime||0)};
  const stamp=seconds=>`${Math.floor(seconds/60)}분 ${(seconds%60).toFixed(1)}초`;
  if(Math.abs(mediaDuration-doc.duration)>.5)warnings.push(`길이가 다릅니다: 자막 ${stamp(doc.duration)} / 원본 ${stamp(mediaDuration)}. 같은 영상의 0초 기준 원본인지 확인해 주세요.`);
  const lastEnd=Math.max(0,...doc.cues.map(c=>c.end));
  if(lastEnd>mediaDuration+.05)warnings.push(`원본 종료 뒤에도 자막이 있습니다 (${stamp(lastEnd)}까지). 잘린 원본 또는 다른 파일일 수 있습니다.`);
  if(currentTime>mediaDuration)warnings.push('기존 미리보기 시각이 원본 길이를 넘어 원본 끝으로 이동했습니다. 자막 시각은 유지됩니다.');
  if(currentTime>doc.duration+.05&&currentTime<=mediaDuration)warnings.push('현재 시각은 자막 문서의 시간 범위 밖입니다. 이 구간의 자막은 표시되지 않습니다.');
  return {warnings,time:Math.max(0,Math.min(mediaDuration,currentTime||0))};
}
