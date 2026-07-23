# Proactive bug discovery

Per-project catalog of structural bug shapes seen in jellyfin-web-codex.
Created on the first qualifying bug fix, per the global bug-class lint
workflow (see the user-level CLAUDE.md "Bug-class lint" section): when a
bug-fix task closes, name the structural shape, grep for siblings, fix them
in the same change, and record the close with the four-clause contract.

Promotion into §4 requires incident evidence (user report, CI failure,
security finding, or postmortem), not theoretical risk.

## §4 Catalog of seen shapes

### 4.1 In-place item transition pushes instead of replacing on an already-active route

- **Shape:** a route parameterized by item id (`/video?id=...`) is re-shown
  through the generic push-navigation path while that route is already
  active, during machine-initiated item transitions (next/previous episode,
  autoplay, queue jump). Each transition stacks a history entry, and because
  the route self-resumes from its URL (permalink resume), Back replays the
  previous item instead of exiting. The invariant "the player owns at most
  one history entry" silently broke when the route's URL became
  item-specific, because the dedupe in `show()` only catches identical URLs.
- **Fix pattern:** the navigation helper for the route detects "already on
  this route" and replaces the history entry instead of pushing
  (`appRouter.showVideoOsd`, 2026-07-23). Pair with a fallback for the
  now-shallower stack: `appRouter.back()` routes home when the tab has no
  session history behind the page.
- **Evidence:** owner report 2026-07-23 ("back button takes you to the
  previous episode instead of going to the homepage... no link to go back to
  the dashboard"), fixed with `src/components/router/appRouter.test.js`
  regression tests.
- **Sibling search:** all `show(...)` targets with query-parameterized URLs
  that can re-fire while their route is active and that self-resume from the
  URL. Only `/video` (via `showVideoOsd`, called from htmlVideoPlayer and
  youtubePlayer, both covered by the shared helper). Tab-switch pushes
  (`livetv?tab=`, `home?tab=`) are user-initiated navigations where
  back-through-history is expected upstream behavior; not siblings.

### 4.2 Module-scope side effect against a circular-import binding

- **Shape:** a module executes a statement at module scope that dereferences
  an imported singleton (`ServerConnections.getApiClients()` in
  `serverNotifications.js`), while sitting on a circular import chain with
  the module that exports it. Whether the binding is initialized depends on
  which entry point evaluates first; some graph orders crash (and under
  vite-node, snapshot semantics make the binding permanently undefined).
  Production only worked by entry-order luck.
- **Fix pattern:** defer the side effect and resolve the dependency via
  dynamic `import()` once the graph has settled; or invert the dependency so
  the composition root injects it (`RootAppRouter` now calls
  `appRouter.initialize(history)`; `appRouter`/`dialogHelper` no longer
  import `RootAppRouter`).
- **Evidence:** vitest run of `appRouter.test.js` failed with
  `TypeError: Cannot read properties of undefined (reading 'getApiClients')`
  (2026-07-23) purely from importing the router module.
- **Sibling search:** `grep -rn "^ServerConnections\.|^playbackManager\.|^appRouter\." src`
  for module-scope singleton calls: only `serverNotifications.js:208`.
  Upward imports of the composition root (`from 'RootAppRouter'`):
  `appRouter.js`, `dialogHelper.js`; both fixed in the same change.

### 4.3 Unbounded retry-and-swallow in a third-party streaming library's fatal-error handler

- **Shape:** an `on('error', ...)` handler for a third-party media/streaming
  library reacts to a *fatal* event by unconditionally re-invoking a
  recovery method (`hls.startLoad()`), with no attempt counter and no
  give-up branch. When the underlying condition is persistent (a server-side
  hang, not a transient blip), the library keeps re-emitting the same fatal
  event forever: the handler keeps retrying, never calls `reject`/surfaces
  an error to the caller, and the UI is left wedged with no user-visible
  feedback and no automatic recovery.
- **Fix pattern:** track a per-attempt retry counter scoped to the binding
  call (not module-level, so it naturally resets per playback session), and
  reset it on a genuine-progress event (`Hls.Events.FRAG_BUFFERED`) rather
  than a fixed time window. After a bounded number of attempts
  (`MAX_FATAL_NETWORK_ERROR_RETRIES = 3`), stop retrying and surface the
  error via the same `reject`/`onErrorInternal` path already used by the
  handler's other terminal branches (`bindEventsToHlsPlayer`,
  `src/components/htmlMediaHelper.js`, t_260722_234509_771).
- **Evidence:** `deliverables/audio-transcode-stall-three-lists.md` timeline
  (server-side segment kill-timer at 19:47:38, no client resume/error
  report until 19:54:52) matches hls.js exhausting its fragment-load retry
  ladder against a hung segment endpoint and going fatal, with the page
  wedging silently; queued as t_260722_234509_771 from that investigation.
  Reproduced directly: `src/components/htmlMediaHelper.test.js` drove the
  real hls.js event bus with repeated fatal `NETWORK_ERROR`/`fragLoadTimeOut`
  events and observed `hls.startLoad()` retry without bound, with no
  `reject`/error event ever firing, before the fix.
- **Sibling search:** grepped `src` for `try to recover`, `startLoad()`,
  `recoverMediaError`, `reconnect`, `retryCount`, `retry(`, and all
  `Hls.Events.ERROR`/`hls.on(` registrations. The only other recovery path
  is `handleHlsJsMediaError`'s `MEDIA_ERROR` recovery (same file, lines
  ~79-110), which already has a bounded give-up via the
  `recoverDecodingErrorDate`/`recoverSwapAudioCodecDate` cooldown-timestamp
  counters -- not a sibling instance. Checked the WebSocket/reconnect logic
  in `src/lib/jellyfin-apiclient/connectionManager.js` (vendored API
  client, different subsystem): only a single `ensureWebSocket()` call, no
  unbounded fatal-retry loop. No other unbounded fatal-error retry loops
  found in `src/`.
