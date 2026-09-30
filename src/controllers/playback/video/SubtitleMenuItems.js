// SlopTank modification notice: added by SlopTank on 2026-09-30.
/**
 * Pure item model for the in-player Subtitles (CC) action sheet: a settings
 * group (icon, current value, chevron) above a divider and the track group
 * (language badge, title, secondary text). No DOM and no I/O, so the grouping
 * rules are unit-testable and the action sheet stays a generic renderer.
 * @module controllers/playback/video/SubtitleMenuItems
 */

export const SIZE_MENU_ID = 'subtitlesize';
export const SECONDARY_MENU_ID = 'secondarysubtitle';
export const OFFSET_MENU_ID = 'subtitleoffset';

const UNKNOWN_LANGUAGE_GLYPH = 'translate';
const OFF_GLYPH = 'subtitles_off';
const UNKNOWN_LANGUAGE_CODES = new Set([ '', 'und', 'zxx', 'mis', 'mul', 'qaa' ]);

/**
 * ISO 639-2 (bibliographic and terminologic) to ISO 639-1. Jellyfin streams
 * carry the three-letter form; only languages with a two-letter code appear.
 */
const ISO_639_2_TO_1 = {
    ara: 'ar', bul: 'bg', cat: 'ca', chi: 'zh', zho: 'zh', cze: 'cs', ces: 'cs', dan: 'da',
    dut: 'nl', nld: 'nl', eng: 'en', est: 'et', fin: 'fi', fre: 'fr', fra: 'fr', ger: 'de',
    deu: 'de', gre: 'el', ell: 'el', heb: 'he', hin: 'hi', hrv: 'hr', hun: 'hu', ice: 'is',
    isl: 'is', ind: 'id', ita: 'it', jpn: 'ja', kor: 'ko', lav: 'lv', lit: 'lt', may: 'ms',
    msa: 'ms', nor: 'no', nob: 'nb', per: 'fa', fas: 'fa', pol: 'pl', por: 'pt', rum: 'ro',
    ron: 'ro', rus: 'ru', slo: 'sk', slk: 'sk', slv: 'sl', spa: 'es', srp: 'sr', swe: 'sv',
    tha: 'th', tur: 'tr', ukr: 'uk', vie: 'vi', wel: 'cy', cym: 'cy'
};

/**
 * Normalize a stream Language to a lowercase code, or null when it says nothing.
 * @param {string|undefined} language - Raw stream Language value.
 * @returns {string|null} Lowercase code, or null for unknown/undetermined.
 */
function normalizeLanguage(language) {
    const code = typeof language === 'string' ? language.trim().toLowerCase() : '';
    return UNKNOWN_LANGUAGE_CODES.has(code) ? null : code;
}

/**
 * Two-letter ISO 639-1 code for a stream, when one exists.
 * @param {string|null} code - Normalized language code.
 * @returns {string|null} The two-letter code, or null.
 */
function toTwoLetterCode(code) {
    if (!code) {
        return null;
    }
    if (code.length === 2) {
        return code;
    }
    return ISO_639_2_TO_1[code] ?? null;
}

/**
 * Badge for a track row: the language code as an uppercase pill (two letters
 * when ISO 639-1 has one, else the three-letter code), or a neutral glyph
 * when the stream carries no usable language. Languages are not countries,
 * so no flags.
 * @param {Object|null|undefined} stream - Media stream with an optional Language.
 * @returns {{text: string}|{icon: string}} Badge for the action sheet item.
 */
export function languageBadge(stream) {
    const code = normalizeLanguage(stream?.Language);
    if (!code) {
        return { icon: UNKNOWN_LANGUAGE_GLYPH };
    }
    return { text: (toTwoLetterCode(code) ?? code.slice(0, 3)).toUpperCase() };
}

/**
 * Secondary line for a track row: the stream's own Title when it adds
 * something the row name does not already say (often a release tag such as
 * "CR"), then Forced, HI/SDH, External and the codec, joined with a middle dot.
 * @param {Object} stream - Media stream.
 * @param {Function} translate - String translation adapter.
 * @param {string} [name] - The row name; a Title that starts with it is not repeated.
 * @returns {string|undefined} Joined text, or undefined when nothing applies.
 */
export function trackSecondaryText(stream, translate, name) {
    const parts = [];
    const title = stream.Title?.trim();
    if (title && name && !title.toLowerCase().startsWith(name.toLowerCase())) {
        parts.push(title);
    }
    if (stream.IsForced) {
        parts.push(translate('LabelIsForced'));
    }
    if (stream.IsHearingImpaired) {
        parts.push(translate('HearingImpairedShort'));
    }
    if (stream.IsExternal) {
        parts.push(translate('MediaInfoExternal'));
    }
    if (stream.Codec) {
        parts.push(String(stream.Codec).toUpperCase());
    }
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Display name for a track: the language's name in the given locale (a
 * stream Title is frequently a release tag, not a language), else the
 * stream's own Title, else the server's DisplayTitle.
 * @param {Object} stream - Media stream.
 * @param {string|undefined} locale - BCP 47 locale for language names.
 * @returns {string} Row title.
 */
function trackName(stream, locale) {
    const twoLetter = toTwoLetterCode(normalizeLanguage(stream.Language));
    if (twoLetter && typeof Intl.DisplayNames === 'function') {
        const named = new Intl.DisplayNames(locale ? [ locale ] : undefined, { type: 'language' }).of(twoLetter);
        // DisplayNames echoes an unrecognized code back unchanged.
        if (named && named.toLowerCase() !== twoLetter) {
            return named;
        }
    }
    return stream.Title || stream.DisplayTitle;
}

/**
 * Off plus one row per track.
 * @param {Object} options - Builder options.
 * @param {Object[]} options.streams - Subtitle streams (without the Off entry).
 * @param {number} options.currentIndex - Active stream index, -1 when Off.
 * @param {Function} options.translate - String translation adapter.
 * @param {string} [options.locale] - Locale for language names.
 * @returns {Object[]} Action sheet items, Off first.
 */
export function buildSubtitleTrackItems({ streams, currentIndex, translate, locale }) {
    return [
        {
            id: -1,
            name: translate('Off'),
            selected: currentIndex === -1,
            badge: { icon: OFF_GLYPH }
        },
        ...streams.map(stream => {
            const name = trackName(stream, locale);
            return {
                id: stream.Index,
                name,
                selected: stream.Index === currentIndex,
                badge: languageBadge(stream),
                secondaryText: trackSecondaryText(stream, translate, name)
            };
        })
    ];
}

/**
 * The whole primary Subtitles menu: settings group, divider, track group.
 * @param {Object} options - Builder options.
 * @param {Object[]} options.streams - Subtitle streams (without the Off entry).
 * @param {number} options.currentIndex - Active stream index, -1 when Off.
 * @param {Function} options.translate - String translation adapter.
 * @param {string} options.appearanceValue - Current size, shown beside Appearance.
 * @param {string} [options.offsetValue] - Current offset, shown beside Offset.
 * @param {boolean} options.showOffset - Whether the offset row applies.
 * @param {boolean} options.showSecondary - Whether the secondary-subtitles row applies.
 * @param {string} [options.secondaryValue] - Current secondary track, shown beside that row.
 * @param {string} [options.locale] - Locale for language names.
 * @returns {Object[]} Action sheet items.
 */
export function buildSubtitleMenuItems({
    streams, currentIndex, translate, appearanceValue, offsetValue, showOffset, showSecondary, secondaryValue, locale
}) {
    const settings = [
        {
            id: SIZE_MENU_ID,
            name: translate('HeaderSubtitleAppearance'),
            icon: 'text_fields',
            asideText: appearanceValue,
            chevron: true
        }
    ];

    if (showOffset) {
        settings.push({
            id: OFFSET_MENU_ID,
            name: translate('SubtitleOffset'),
            icon: 'sync',
            asideText: offsetValue,
            chevron: true
        });
    }

    if (showSecondary) {
        settings.push({
            id: SECONDARY_MENU_ID,
            name: translate('SecondarySubtitles'),
            icon: 'subtitles',
            asideText: secondaryValue,
            chevron: true
        });
    }

    return [
        ...settings,
        { divider: true },
        ...buildSubtitleTrackItems({ streams, currentIndex, translate, locale })
    ];
}
