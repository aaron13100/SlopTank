// .dependency-cruiser.js - layer boundary + circular dependency gates.
//
// This is a baseline ratchet, the same shape as tests/modularity.test.js:
// this repo is a ~790-file fork of upstream jellyfin-web whose import graph
// was never kept acyclic or layered, so a zero-tolerance gate would fail on
// day one. .dependency-cruiser-known-violations.json (generated via
// `npm run depcruise:baseline`) records the violations that already existed
// when this gate was scaffolded (2026-07-23) as debt, not licence: any
// violation not already in that file fails the build. Shrink the snapshot
// over time by fixing an entry, then regenerating the file.
//
// Rules:
//
// 1. no-circular: import cycles make refactors brittle and are the exact
//    shape behind the module-scope-singleton crash class recorded in
//    docs/PROACTIVE_BUG_DISCOVERY.md #4.2 (a module-scope statement
//    dereferencing an import that hasn't initialized yet because the two
//    modules import each other). New cycles are forbidden; the ~36 modules
//    already tangled together (dialogHelper/appRouter/playbackmanager and
//    friends) are recorded as known violations.
//
// 2. no-importing-apps-composition-root: src/apps is the composition root
//    assembled by src/RootApp.tsx -> src/RootAppRouter.tsx. Everything else
//    reaching back into it hides a dependency the composition root should
//    own outright, and is structurally the same mistake that caused #4.2
//    (this time one layer up: a "leaf" depending on the thing that
//    assembles it, instead of the other way around). A handful of
//    pre-existing reach-ins (from an in-progress migration of shared code
//    into apps/*/features/*) are recorded as known violations; do not add
//    new ones.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
    forbidden: [
        {
            name: 'no-circular',
            severity: 'error',
            comment: 'Import cycle detected. See the rule comment in .dependency-cruiser.js.',
            from: {},
            to: { circular: true }
        },
        {
            name: 'no-importing-apps-composition-root',
            severity: 'error',
            comment: 'src/apps is the composition root; nothing outside it (or the two root files that assemble it) may import from it. See the rule comment in .dependency-cruiser.js.',
            from: { pathNot: '^src/(apps/|RootApp\\.tsx$|RootAppRouter\\.tsx$)' },
            to: { path: '^src/apps/' }
        }
    ],
    options: {
        doNotFollow: { path: 'node_modules' },
        exclude: { path: '\\.(test|spec)\\.[jt]sx?$' },
        tsConfig: { fileName: 'tsconfig.json' },
        enhancedResolveOptions: {
            exportsFields: [ 'exports' ],
            conditionNames: [ 'import', 'require', 'node', 'default' ]
        }
    }
};
