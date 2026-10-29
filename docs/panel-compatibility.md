> Historical 0.3.1 verification. Full-audio acquisition was subsequently fixed and tested in 0.3.3; see [current verification](direct-audio-032.md).

# Embedded panel compatibility repair (0.3.1)

## Observed on 2026-10-28

- The real Chrome YouTube tab for `-wbEQJ_ZXyk` opened successfully and the automation tool paused the video at 0:06 / 6:01.
- A later observation, after the page-embedded extension panel had loaded, was rejected because another extension UI was open. Closing that test tab through the same tool was also rejected.
- The user closed that tab. A fresh blank Chrome tab was then readable again.
- The browser tool separately rejected `chrome://extensions/` under its URL policy. No alternate mechanism was used to bypass that rejection.

The old panel used a `chrome-extension://.../popup.html` iframe. The timing and code identify that frame as a likely conflict. The later repaired live run below did not reproduce the automation block; this is evidence of improved compatibility, not proof of a browser-internal root cause.

## Repair

The YouTube panel now renders the packaged UI in a ShadowRoot through the isolated content script. It no longer creates an extension iframe or exchanges panel commands through page messages. The toolbar popup and embedded panel share the same controls implementation and generated HTML/CSS template. No additional permissions are requested.

Only trusted user events operate the embedded controls. Local-analysis consent from the content script is accepted only for this extension's top-level YouTube frame. Tab recording still needs Chrome's existing toolbar grant and is never an automatic fallback.

## Verification boundary

Automated tests cover panel mounting without an iframe, layout movement, collapse/expand, full-screen hiding, control actions, X/Y persistence/reset, trusted input, consent sender validation, and existing full-analysis/capture lifecycle contracts. The whole-video download/inference tests use controlled inputs and do not establish that YouTube exposes downloadable audio for this particular real video.

The prepared local source is version 0.3.1. The user reloaded the installed extension and the live results below supersede the earlier pending status. This document does not claim successful whole-video analysis.

## Live reload follow-up

After the user confirmed Chrome showed 0.3.1, the real YouTube page was controllable, but the panel did not mount. Chrome reported `Failed to fetch dynamically imported module: chrome-extension://amafcdcihcfadmdfodlgdaphoapaacom/panel.js`. This is a failed run, not confirmation that panel interaction works.

The content entry and all of its local dependencies are now built into a single manifest-injected `content.js`. `scripts/build_content.mjs` builds it reproducibly; runtime dynamic module fetches are no longer needed. The source is `extension/content-entry.js`. The build regression test compares the generated artifact with a fresh build and requires zero external imports.

A page-only reload still executed the cached previous content script. The user therefore reloaded the extension once more; the version remains 0.3.1.

## Completed live checks

- The new panel mounted beside the real YouTube video. Setup, analysis, settings, JSON file selection, position controls, page reload and screenshots were operable without the earlier extension-UI block.
- Whole-video analysis was attempted twice. Both attempts failed before download/inference because no eligible direct audio URL was selected. After the second attempt, the visible error used the new wording, confirming the updated source was running. No newly analyzed document was published and the overlay was empty after failure.
- The existing `work/onsori/source-correction/verified-captions.json` was imported through the actual panel file picker. It has 14 previously analyzed/corrected cues covering approximately the first minute. It is NOT a new whole-video result.
- The real overlay displayed `이것은 옷이오, 이불이오?` at 0:05. Its old music cue is generic; this run does not establish improved music-description quality or browser inference accuracy.
- X/Y controls moved the caption center from 50%/88% to 30%/50%. For a 1107.36 x 622.89 player, the moved box was x=180.25, y=267.46, width=303.69, height=88.08 relative to the player, giving center=(332.09,311.50), as expected.
- A page reload retained X=30/Y=50 and the imported document. The reset control restored 50/88. Screenshots are in `work/onsori/live-031/` at the project root.

## Additional repairs and remaining limit

The live run exposed a background-tab setup error: consent was saved, but auto-start threw if the foreground tab was not YouTube. Auto-start now skips that case; explicit analysis still targets the panel's own video. A regression test covers non-YouTube and missing active tabs.

The player-source bridge now combines the player's response with the initial response only when each belongs to the current video. This repairs omitted streaming data without borrowing URLs or captions from an earlier SPA video. Regression tests cover stripped responses, stale video identity, player exceptions, and foreign messages. This change did not unblock this particular live video.

All 100 automated tests passed. These are distinct from the unsuccessful live whole-video analysis. The browser diagnostic capability rejected network observation with `Raw CDP is unavailable while Browser Use is resolving a paused document response`; no alternate route was used to bypass that restriction. The precise upstream reason for the absent eligible source remains unverified (for example, stripped/ciphered formats cannot be distinguished from the visible error alone).

The release package is prepared locally, not submitted to the Chrome Web Store. Further work is required for reliable whole-video acquisition on this video; rendering and placement success must not be described as end-to-end inference success.
