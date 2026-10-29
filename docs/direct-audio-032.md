# Direct whole-audio retrieval — 0.3.2

- Target: https://www.youtube.com/watch?v=-wbEQJ_ZXyk (361 seconds).
- Root defect: only page-provided direct audio formats were considered. A valid player response without those URLs immediately failed before any independent source lookup.
- Implemented: yt-dlp 2026.10.21 VISIONOS client protocol adapted to bundled JavaScript. Fresh anonymous public watch context; fixed YouTube player endpoint; strict same-video/duration validation; audio-only selection; byte ranges with exact length validation; per-request timeouts and cancellation. Existing direct URL is used first and one fresh lookup follows a missing/failed URL.
- No server, Python, account cookies, remote executable code, playback or recording required for this retrieval path. Existing 20-minute / 100MB limits retained.
- Tests: 106 passed, including missing formats, expiry, no playback/recording, cancellation, wrong ID/duration, short ranges and host validation.
- Live Node execution of the SAME extension module: 2,203,985 bytes downloaded in 1.245 seconds. ffprobe: AAC, 44.1kHz stereo, 361.256054 seconds. This timing excludes AI inference. Artifacts: work/onsori/direct-audio-test/browser-adapter.m4a and download-result.json.
- Separate yt-dlp verification downloaded the 128kbps AAC track (5.58MiB). yt-dlp is used for research verification only, not a runtime dependency.
- Installed Chrome 0.3.2: failed with HTTP 403 while paused at 7.643667 seconds. No recording was started. Browser inference was not reached.
- Root cause reproduced with controlled HTTP requests: an extension Origin causes the player endpoint to return 403; Chrome User-Agent alone and a YouTube Origin return 200. Media GET with an extension Origin succeeds.
- 0.3.3 fix: anonymous player lookup in the isolated YouTube content script, relayed through the session-bound service worker to offscreen download/inference. No additional permission or header rewriting. Cancellation, video identity and source validation retained.
- Installed Chrome 0.3.3 end-to-end verification completed on 2026-10-29: full 361.256-second audio analyzed with the YouTube video paused at 8.608269 seconds throughout download and inference. 119 newly generated cues applied (82 speech / 25 music / 12 sound). Exported JSON confirms `analysis_scope: full-video`, `audio_analyzed: true`, `audio_transport: youtube-page-visionos`. No tab recording or full playback was used. This is the actual installed extension result, not an imported fixture.
- X/Y changed from 50/88 to 29/49, rendered on the actual result, persisted after refresh, and reset to 50/88. Refresh triggered ordinary YouTube autoplay for about six seconds after analysis was complete; it was paused for verification. The cached 119 cues survived refresh without reanalysis. Actual rendered cue sizes observed: 21.5px and 20px for two different speech cues, with base 14px and responsive scaling.
- Automated checks: 110 passed before installed Chrome verification. Evidence and exported result: `work/onsori/live-033/` under the project root.
- Remaining quality findings: Whisper still transcribes the opening as `이것은 5시오 이불이요?`; all 25 music cues use the generic fallback. This video supplies no native caption track, and full-audio mode does not collect OCR frames. Detailed music characterization and speech accuracy are not verified as successful. CPU inference is slow. Keyboard arrows in the embedded position controls also reach YouTube's seek shortcuts; pointer-based position controls and reset are usable. These findings are separate from the resolved direct-audio retrieval failure.
- Known boundary: YouTube client availability can change. LOGIN_REQUIRED / unavailable playback status stops with a truthful error. No challenge solver, login bypass or autoplay capture fallback is included.

## Upstream
https://github.com/yt-dlp/yt-dlp/blob/2026.10.21/yt_dlp/extractor/youtube/_base.py
Unlicense; notice included in extension/YT-DLP-NOTICE.txt.

SABR alternatives reviewed: LuanRT/googlevideo and LuanRT/kira. Their example downloader requires player-script execution and token generation; those were not incorporated.

Chrome documents that content-script requests use the injected web origin: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
