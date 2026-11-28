// OnSori pilot server (NAVER Cloud, aitestbed.kr support, 2026-11-02 ~ 2026-12-02,
// extendable once). With consent, speech (DeepInfra, when offered) and music/effect names
// (Google Gemini 4 Hydrogen) come from the server; consent version 2 added the latter.
export const CLOUD=Object.freeze({
  origin:'https://211-233-192-122.sslip.io',
  consentVersion:2,
  pollSeconds:3,
  // Server provider timeout (180 s) plus queue wait for a 20-minute video.
  maxWaitSeconds:600,
});
