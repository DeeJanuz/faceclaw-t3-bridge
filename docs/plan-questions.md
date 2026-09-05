# Answering plan questions on G2

The bridge can answer a structured input request from an **existing T3 plan-mode thread**. It does not enable plan mode or create a new thread. Open the waiting thread from Sessions or a dashboard alert. A question card appears over the lower part of its transcript.

| Screen | Tap | Swipe up/down | Tap then hold | Double tap |
| --- | --- | --- | --- | --- |
| Question | Open choices | Read longer questions | Next question, Previous question, Review answers | Return to the originating dashboard or project/session list |
| Choices | Choose the displayed answer | Browse choices and longer descriptions | Navigate questions or review | Return to the originating screen |
| Multi-select choices | Toggle the displayed choice; choose **Use selected answers** when ready | Browse choices | Navigate questions or review | Return to the originating screen |
| Dictation | Stop recording | — | Disabled during recording/review | Cancel and return to the originating screen |
| Dictated answer review | Keep this answer locally | Read the answer | Disabled | Discard this recording and return to the originating screen |
| Answer review | Read the next review page | Browse review pages and the final submit card | Reopen any question using Next/Previous | Return without submitting |
| Final submit card | Submit the complete answer set | Return to review pages | Reopen questions | Return without submitting |

The last choice is always **Dictate your own answer**. Speak, tap to stop, review, and tap to keep it. Keeping an answer advances to the next unanswered question. Once every question has an answer, review opens automatically. Swiping or tapping through that review reaches the separate **Submit answers** card; only its tap sends anything to T3.

The contextual menu is Even's native menu. Tap then hold, then select **Next question**, **Previous question**, or **Review answers**. Next/Previous wrap through the request's questions, including answered questions so you can correct them. Opening or dismissing that menu does not reset your answers.

## Saved choices and submission safety

Choices are stored separately from pairing credentials, scoped to the normalized bridge endpoint, thread, request, and exact question revision. Native storage keeps at most 16 request drafts per endpoint for seven days. A failed native save retains choices in memory for the running app session and reports the storage problem on the phone. Storage reads show an exit-capable loading card; stalled native operations time out. The browser fixture uses in-memory storage only and does not survive a page reload.

Double tap never sends a partial set. Previously accepted choices remain available when you reopen the same pending request. An unfinished recording or its unaccepted transcription is discarded. Questions changed, resolved, or withdrawn in T3 invalidate the old choices. Transcript updates keep the current question and selection stable while the request is unchanged.

Before submission, the app checks the complete answer set, locks it, and attempts to persist that lock. Oversized local answers remain editable. The bridge checks the current thread, project access, live pending request, question revision, and all answers before dispatching one T3 user-input response command. T3's durable command ID prevents duplicate response commands. This path does not send a normal message, approve tools, change permissions, or change interaction mode.

If the connection fails during submission, the app cannot know whether T3 accepted the command. It keeps the answer set locked and checks the transcript when reopened. If the request remains stuck, inspect and resolve it in T3 on the Mac. The glasses deliberately do not offer an editable second submission for that uncertain request. A successful command receipt confirms T3 accepted the response command; provider processing can still fail afterward.

## Compatibility and testing

The integration was checked against installed T3 Code 0.0.38. Older bridges without `pendingPlanInput` continue to show ordinary transcripts. Only valid, bounded structured input requests in active plan-mode turns appear; ordinary approval requests remain in T3. The bridge supports up to 12 questions and 12 suggested options per question, plus the glasses' custom-answer choice.

Open `http://localhost:5178/tests/manual/dashboard.html?browser=1` and select **Open plan questions** to try a synthetic three-question request. The top **Hold menu** buttons call the same native menu-event handlers. The **Plan submissions** counter stays at zero until the final explicit submit. This fixture sends no T3 command and captures no real audio. Omit `?browser=1` when opening it in the Even simulator.

Automated coverage includes complete-only submission, partial draft restoration, endpoint/revision isolation, storage failure, duplicate commands, stale requests, native-menu preservation, multi-select, custom dictation, and leaving during finalization or submission. Run `npm run check:all`.

On 2026-09-04, the integrated check passed 188 frontend, 22 deployment, and 103 bridge tests. The browser fixture was exercised through question cards, multi-select acceptance, all three answers, previous-question navigation, exit/resume, full review, and final submission. Its counter stayed at zero through review and became one only after the final submit tap. The restarted native simulator reported no console errors and remained running with Vite. The installed Mac bridge was left unchanged while separate archive work was being edited in the shared checkout; install the updated bridge before testing live plan requests on G2.

The native SDK exposes page rebuilds rather than transform animations. The glasses renderer uses bounded intermediate frames for full-card transitions; notification overlays preserve the resident background. The phone mirror animates with browser transforms. Native card bounds, capture targets, menu entries, and z-order values are validated in tests. Smoothness, actual G2 pixels, tap-and-hold behavior, and microphone delivery still require a real-device check. Simulator RGBA screenshots must be composited over black. See the [dashboard design guide](even-dashboard-guidelines.md).
