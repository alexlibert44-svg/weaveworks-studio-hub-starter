# Separate word preparation from audio

## Confirmed scope
- Keep the current app, UI, database structure, review rules, skill progress, and existing saved data unchanged.
- No database migration or new service is necessary. The existing Play audio request already generates missing audio and caches successful recordings.

## Smallest safe changes
1. Remove audio preparation from the word/form analysis path. Translations, examples, learning items, and meaning options must finish their existing validation and saving before the word is marked ready; text-generation failures must still remain genuine failures.
2. Keep lazy audio generation and stored-audio reuse. An audio failure must remain an audio-only retry state, never update word analysis or learner progress, and never cache fake success.
3. Verify Gemini TTS model support and endpoint against official documentation before changing them. Keep the owner's Gemini key server-only; do not fall back to Lovable after a Gemini failure. Do not introduce paid services or change billing.
4. Check the reported mobile-hook error against actual diagnostics; change it only if a real error remains.

## Verification
- Add and run focused tests proving that audio cannot block word readiness, that genuine text-analysis failures still fail, and that retry does not duplicate saved content.
- Exercise the signed-in Word Set creation flow in the real app; inspect saved translations, examples, exercise data, and ready status, then refresh and confirm they persist.
- Verify an audio failure remains isolated and offers retry. A successful provider/audio request will only be reported if actually observed; unavailable credentials, quotas, and checks not performed will be listed explicitly.
- Use the existing provider and account only. Stop before any test requiring new spending or a new paid service.

## Technical details
- Primary change: `src/lib/verba/analysis.ts`; retain `wordReady` and the existing saved-data checks.
- Preserve `speech.ts` → `/api/tts` → `tts.server.ts` for lazy audio and caching. Touch audio transport/button code only if verification shows a necessary correction.
- Update the existing architecture rule and add small regression tests; no schema or review-function changes.

## Final report
State the observed root cause, actual files changed, real-app checks performed, and any exact remaining errors, distinguishing text analysis from audio.