# SlopTank asset attributions

SlopTank is an independent fork of Jellyfin Web. It is not affiliated with,
endorsed by, or supported by Jellyfin or by any company or project identified
below. Product names and logos are used only to identify the client, platform,
or rating source represented in the interface. No trademark licence or
endorsement is implied.

Except where this file says otherwise, these assets are distributed as part of
SlopTank under the repository's `GPL-2.0-only` licence. A copyright licence does
not grant rights in a third party's trademark.

## Current generic interface artwork

The eight SVGs under `src/assets/img/devices/` were drawn for SlopTank as
simple category symbols: web browser, television, game console, mobile device,
media player, audio player, home automation, and a general connected-device
fallback. They contain no third-party name, logo, character, or copied vector.
To the extent copyright or any other licensable rights exist in these files,
the project owner licenses those rights under `GPL-2.0-only`.

Critic scores use the text symbols `+` and `−`, an accessible text label, and
colour as a redundant cue. They do not use rating-service artwork. Product and
platform names returned by the server remain visible as factual session
metadata where needed to identify a client's software or device.

## Removed legacy artwork

The fork previously contained 22 device/platform SVGs received through
Jellyfin Web and the `fresh.svg` and `rotten.svg` rating graphics received in
[Jellyfin Web commit `a9833ba`](https://github.com/jellyfin/jellyfin-web/commit/a9833ba3981425515a426d0692ae41d1c57bbf00).
They were available under the inherited `GPL-2.0-only` licence, but many
depicted third-party marks. SlopTank removed all 24 files before commercial
distribution; their provenance remains available in repository history.

The removed device filenames were: `android.svg`, `apple.svg`, `chrome.svg`,
`edge.svg`, `edgechromium.svg`, `finamp.svg`, `firefox.svg`, `firetv.svg`,
`home-assistant.svg`, `html5.svg`, `kodi.svg`, `msie.svg`, `opera.svg`,
`other.svg`, `playstation.svg`, `roku.svg`, `safari.svg`, `samsungtv.svg`,
`titanos.svg`, `webos.svg`, `windows.svg`, and `xbox.svg`.

## SlopTank profile avatars

All 24 files below were generated specifically for SlopTank using OpenAI image
generation, selected and processed by the SlopTank project owner, and first
published in [SlopTank commit `6b0caa3`](https://github.com/aaron13100/SlopTank/commit/6b0caa3c89a4dddf61260789af79dc8bc059aa06).
The prompts required unbranded objects with no text, logo, trademarked
character, or watermark. To the extent copyright or any other licensable
rights exist in the resulting files, the project owner licenses those rights
under `GPL-2.0-only`. OpenAI does not sponsor or endorse SlopTank.

- `astronaut-helmet.png`
- `bicycle-helmet.png`
- `black-cat.png`
- `bonsai-tree.png`
- `book-stack.png`
- `bouldering-shoe.png`
- `burrito.png`
- `camera.png`
- `cowboy-boot.png`
- `electric-guitar.png`
- `espresso.png`
- `game-controller.png`
- `knitting-yarn.png`
- `magical-wand.png`
- `mushroom.png`
- `ramen-bowl.png`
- `rubber-duck.png`
- `samurai-helmet.png`
- `skateboard.png`
- `skull.png`
- `swim-goggles.png`
- `taiko-drum.png`
- `telescope.png`
- `twenty-sided-die.png`

## Translation corpus

All 105 JSON files under `src/strings/` descend from the Jellyfin Web
translation corpus. Translation work is managed through the
[Jellyfin Weblate project](https://translate.jellyfin.org/projects/jellyfin/jellyfin-web/),
and its contributor identities and per-language history are preserved in the
[upstream Git history](https://github.com/jellyfin/jellyfin-web/commits/master/src/strings).
The SlopTank copy forked from upstream history at
[`ef6d604`](https://github.com/jellyfin/jellyfin-web/commit/ef6d604873beb8807ae5ef79d2598a33bc1ba478)
and includes later SlopTank-specific changes, primarily in `en-us.json`.
The full corpus and SlopTank modifications are distributed under
`GPL-2.0-only`; authorship is attributed through the retained Git history and
the Weblate project rather than an incomplete hand-maintained name list.

## Contributor list

`CONTRIBUTORS.md` is the inherited Jellyfin contributor list as it existed at
the fork point. Its last inherited change is
[Jellyfin Web commit `44c40ee`](https://github.com/jellyfin/jellyfin-web/commit/44c40eecf6e49bd3ca04c9106386daec7db588c7),
and it is retained as upstream attribution under `GPL-2.0-only`. Its heading
deliberately continues to say "Jellyfin Contributors" because it identifies
the upstream contributors, not the authorship or endorsement of SlopTank.
