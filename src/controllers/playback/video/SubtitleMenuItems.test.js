// SlopTank modification notice: added or changed by SlopTank on 2026-10-01.
import { describe, expect, it } from 'vitest';

import {
    buildSubtitleMenuItems,
    buildSubtitleTrackItems,
    languageBadge,
    trackSecondaryText
} from './SubtitleMenuItems';

/**
 * Item-model coverage for queue task c307: the Subtitles menu is two visually
 * distinct groups (settings rows, then Off plus tracks) built from generic
 * actionSheet item fields.
 */

const translate = key => ({
    HeaderSubtitleAppearance: 'Subtitle Appearance',
    SubtitleOffset: 'Subtitle Offset',
    SecondarySubtitles: 'Secondary Subtitles',
    LabelIsForced: 'Forced',
    MediaInfoExternal: 'External',
    HearingImpairedShort: 'HI/SDH',
    Off: 'Off'
}[key] ?? key);

const english = { Index: 3, Language: 'eng', Title: 'English', DisplayTitle: 'English - SRT', Codec: 'srt', IsExternal: true };
const french = { Index: 4, Language: 'fre', DisplayTitle: 'French - ASS', Codec: 'ass', IsForced: true };
const mystery = { Index: 5, DisplayTitle: 'Track 5', Codec: 'pgssub' };

describe('languageBadge', () => {
    it('renders a two-letter uppercase pill from an ISO 639-2 stream Language', () => {
        expect(languageBadge({ Language: 'eng' })).toEqual({ text: 'EN' });
        expect(languageBadge({ Language: 'fre' })).toEqual({ text: 'FR' });
        expect(languageBadge({ Language: 'fra' })).toEqual({ text: 'FR' });
        expect(languageBadge({ Language: 'ger' })).toEqual({ text: 'DE' });
    });

    it('keeps a two-letter code as is, uppercased', () => {
        expect(languageBadge({ Language: 'ja' })).toEqual({ text: 'JA' });
    });

    it('falls back to the three-letter code for a language with no two-letter form', () => {
        expect(languageBadge({ Language: 'fil' })).toEqual({ text: 'FIL' });
    });

    it('uses the neutral glyph for unknown, undetermined or missing languages', () => {
        const glyph = { icon: 'translate' };
        expect(languageBadge({})).toEqual(glyph);
        expect(languageBadge({ Language: '' })).toEqual(glyph);
        expect(languageBadge({ Language: 'und' })).toEqual(glyph);
        expect(languageBadge({ Language: 'zxx' })).toEqual(glyph);
        expect(languageBadge(null)).toEqual(glyph);
    });
});

describe('trackSecondaryText', () => {
    it('joins Forced, SDH, External and the codec', () => {
        expect(trackSecondaryText(english, translate)).toBe('External · SRT');
        expect(trackSecondaryText(french, translate)).toBe('Forced · ASS');
        expect(trackSecondaryText({ ...french, IsHearingImpaired: true, IsExternal: true }, translate))
            .toBe('Forced · HI/SDH · External · ASS');
    });

    it('is undefined when the stream carries nothing to say', () => {
        expect(trackSecondaryText({ Index: 9 }, translate)).toBeUndefined();
    });
});

describe('buildSubtitleTrackItems', () => {
    it('lists Off first, with a glyph badge and the selected flag on the active entry', () => {
        const items = buildSubtitleTrackItems({ streams: [ english ], currentIndex: -1, translate });
        expect(items[0]).toMatchObject({ id: -1, name: 'Off', selected: true, badge: { icon: 'subtitles_off' } });
        expect(items[1]).toMatchObject({ id: 3, name: 'English', selected: false, badge: { text: 'EN' }, secondaryText: 'External · SRT' });
    });

    it('falls back to DisplayTitle when the stream has no Title', () => {
        const items = buildSubtitleTrackItems({ streams: [ mystery ], currentIndex: 5, translate });
        expect(items[1]).toMatchObject({ id: 5, name: 'Track 5', selected: true, badge: { icon: 'translate' } });
    });
});

describe('track names from language', () => {
    it('names a track by its language and demotes a non-language Title to secondary text', () => {
        const release = { Index: 6, Language: 'ara', Title: 'CR', DisplayTitle: 'Arabic - ASS', Codec: 'ass' };
        const items = buildSubtitleTrackItems({ streams: [ release ], currentIndex: 6, translate, locale: 'en' });
        expect(items[1]).toMatchObject({ name: 'Arabic', secondaryText: 'CR \u00b7 ASS', badge: { text: 'AR' } });
    });

    it('does not repeat a Title that already starts with the language name', () => {
        const sdh = { Index: 7, Language: 'eng', Title: 'English [SDH]', DisplayTitle: 'English', Codec: 'srt' };
        const items = buildSubtitleTrackItems({ streams: [ sdh ], currentIndex: -1, translate, locale: 'en' });
        expect(items[1]).toMatchObject({ name: 'English', secondaryText: 'SRT' });
    });

    it('keeps the Title as the name when the language is unknown', () => {
        const items = buildSubtitleTrackItems({
            streams: [ { Index: 8, Title: 'Commentary', DisplayTitle: 'Commentary', Codec: 'srt' } ],
            currentIndex: -1,
            translate
        });
        expect(items[1]).toMatchObject({ name: 'Commentary', secondaryText: 'SRT' });
    });
});

describe('buildSubtitleMenuItems', () => {
    const base = { streams: [ english, french ], currentIndex: 3, translate, appearanceValue: '100%' };

    it('puts the settings group first, then a divider, then Off and the tracks', () => {
        const items = buildSubtitleMenuItems({ ...base, offsetValue: '+0.5s', showOffset: true, showSecondary: true });
        expect(items.map(item => item.divider ? '---' : item.name)).toEqual([
            'Subtitle Appearance', 'Subtitle Offset', 'Secondary Subtitles', '---', 'Off', 'English', 'French'
        ]);
    });

    it('gives every settings row an icon, a chevron and the current value as aside text', () => {
        const items = buildSubtitleMenuItems({ ...base, offsetValue: '+0.5s', showOffset: true, showSecondary: true, secondaryValue: 'Off' });
        expect(items.slice(0, 3)).toEqual([
            { id: 'subtitlesize', name: 'Subtitle Appearance', icon: 'text_fields', asideText: '100%', chevron: true },
            { id: 'subtitleoffset', name: 'Subtitle Offset', icon: 'sync', asideText: '+0.5s', chevron: true },
            { id: 'secondarysubtitle', name: 'Secondary Subtitles', icon: 'subtitles', asideText: 'Off', chevron: true }
        ]);
    });

    it('shows the current secondary track beside the secondary row', () => {
        const items = buildSubtitleMenuItems({ ...base, showSecondary: true, secondaryValue: 'FR' });
        expect(items[1]).toMatchObject({ id: 'secondarysubtitle', asideText: 'FR' });
    });

    it('omits the optional settings rows when unavailable but always keeps appearance and the divider', () => {
        const items = buildSubtitleMenuItems({ ...base, showOffset: false, showSecondary: false });
        expect(items.map(item => item.divider ? '---' : item.name)).toEqual([
            'Subtitle Appearance', '---', 'Off', 'English', 'French'
        ]);
    });

    it('does not put badges on settings rows, nor chevrons on tracks', () => {
        const items = buildSubtitleMenuItems({ ...base, showOffset: true, showSecondary: true });
        const settings = items.slice(0, 3);
        const tracks = items.slice(4);
        expect(settings.every(item => item.badge === undefined && item.chevron === true)).toBe(true);
        expect(tracks.every(item => item.chevron === undefined && item.badge !== undefined)).toBe(true);
    });
});
