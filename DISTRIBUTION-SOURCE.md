<!-- SlopTank modification notice: added or changed by SlopTank on 2026-09-07, 2026-09-08, 2026-09-09, 2026-11-03, 2026-11-05. -->
# SlopTank web distribution source and licence election

Every released web directory must contain `SOURCE-MANIFEST.json`. That
manifest names an immutable source archive, its SHA-256 digest, the exact Git
commit, dependency-lock and build-recipe digests, the toolchain, the licence
option used, and a digest of the completed artifact. The archive must be
reachable by an unauthenticated recipient before the artifact is activated or
delivered. A nearby branch, tag, or archive from a similar commit is not the
corresponding source for that artifact.

The source archive includes this file, `release-source.json`, the lockfile,
the build configuration and installation material. Archives and their URLs
are retained for the period recorded in each artifact manifest. Each
versioned deployment, including one retained for rollback, keeps its own
manifest and points to its own archive.

## Candidate licence version

The current web candidate exercises GNU GPL version 3 under its existing
express GPL-2.0-or-later program grant, independently of the server grant
interpretation. Independently copyrightable post-fork changes owned by the
SlopTank maintainer retain their GPL-2.0-or-later election. The exact scoped
manifest policy is:

`inherited-web=GPL-2.0-or-later;owner-increments=GPL-2.0-or-later;candidate-binary-election=GPL-3.0-only`

This is a claim by SlopTank about the candidate election supported by the
existing web grant, not authority to relicense earlier contributors. The
historical GPL-2 declaration and later correction remain contrary context;
this document does not assert universal contributor consent or override a
separately restricted grant. The root licence text and component notices
remain intact.

The candidate election does not qualify an output bundle. Release still
requires the exact shipped dependencies, assets, translations, notices and
corresponding source to satisfy their applicable grants. A compatible
package label alone does not establish those facts.

## Handwritten source gate

`scripts/handwritten-source-provenance.json` is the reviewed inventory for
source comments that identify copied, adapted, or technique-derived
handwritten code. It also records retained inline-licensed source, removed
legacy source, and original replacements. The private release gate compares
the inventory with markers in the current source tree and rejects an unknown
derivation marker. `ATTRIBUTIONS.md` carries the corresponding human-readable
notice.

The old Chromecast lifecycle said it was based on Google's
[`CastVideos-chrome`](https://github.com/googlecast/CastVideos-chrome/tree/e97c410d0f21d38f2717c990df10db8577958cc4)
sample, which Google's repository distributes under
[Apache License 2.0](https://github.com/googlecast/CastVideos-chrome/blob/e97c410d0f21d38f2717c990df10db8577958cc4/LICENSE).
The Apache Software Foundation documents
[Apache-2.0 as incompatible with GPL version 2](https://www.apache.org/licenses/GPL-compatibility.html).
The old source comment linked a mutable branch and did not establish which
historical sample revision was used; retained Jellyfin history starts after
the sample-based file already existed. SlopTank therefore removed that
implementation and replaced it with an original adapter written from the
official
[Cast Web Sender Base API](https://developers.google.com/cast/docs/reference/web_sender/chrome.cast)
contracts. The old `fetchLocal.ts` comments pointing to `github/fetch` were
attached to an implementation substantially similar in structure and error
text to the cited short discussion snippet. Whether that idiomatic wrapper
contained protectable expression, and whether the repository's MIT licence
covered discussion text, were not relied upon: the similar code was removed
fail closed and replaced with an independently structured browser-API
implementation based on the normative
[Fetch](https://fetch.spec.whatwg.org/), [URL](https://url.spec.whatwg.org/),
and [XMLHttpRequest](https://xhr.spec.whatwg.org/) standards. An unused copied
filename sanitizer was removed. No claim is made that a text scan can prove
the absence of undisclosed copying; the gate is a fail-closed control for
declared derivation markers and the known implementation fingerprints reviewed
for this release.

## Reproducing the web artifact

Use the committed recipe in `release-source.json`. In summary, use the stated
Node and npm versions, run `npm ci`, and then run `npm run build:production`.
The completed `dist` directory is sealed only after the exact source archive
is already published and verified. Do not build or distribute from a dirty
working tree.
