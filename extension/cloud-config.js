// OnSori pilot server (NAVER Cloud, aitestbed.kr support, 2026-11-02 ~ 2026-12-02,
// extendable once). Only speech goes to the cloud; music and effects stay local.
export const CLOUD=Object.freeze({
  origin:'https://211-233-192-122.sslip.io',
  consentVersion:1,
  pollSeconds:3,
  // Server provider timeout (180 s) plus queue wait for a 20-minute video.
  maxWaitSeconds:600,
});
