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
