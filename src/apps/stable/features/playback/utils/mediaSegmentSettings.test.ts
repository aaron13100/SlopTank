import { MediaSegmentType } from '@jellyfin/sdk/lib/generated-client/models/media-segment-type';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UserSettings } from 'scripts/settings/userSettings';

import { MediaSegmentAction } from '../constants/mediaSegmentAction';
import { getId, getMediaSegmentAction } from './mediaSegmentSettings';

describe('getId()', () => {
    it('prefixes the segment type', () => {
        expect(getId(MediaSegmentType.Intro)).toBe('segmentTypeAction__Intro');
        expect(getId(MediaSegmentType.Commercial)).toBe('segmentTypeAction__Commercial');
    });
});

describe('getMediaSegmentAction()', () => {
    let userSettings: UserSettings;

    beforeEach(() => {
        localStorage.clear();
        userSettings = new UserSettings();
    });

    afterEach(() => {
        localStorage.clear();
    });

    it('defaults Intro, Recap and Outro to AskToSkip when unset', () => {
        expect(getMediaSegmentAction(userSettings, MediaSegmentType.Intro)).toBe(MediaSegmentAction.AskToSkip);
        expect(getMediaSegmentAction(userSettings, MediaSegmentType.Recap)).toBe(MediaSegmentAction.AskToSkip);
        expect(getMediaSegmentAction(userSettings, MediaSegmentType.Outro)).toBe(MediaSegmentAction.AskToSkip);
    });

    it('defaults every other segment type to None when unset', () => {
        expect(getMediaSegmentAction(userSettings, MediaSegmentType.Commercial)).toBe(MediaSegmentAction.None);
        expect(getMediaSegmentAction(userSettings, MediaSegmentType.Preview)).toBe(MediaSegmentAction.None);
    });

    it('returns the stored user preference when one has been saved', () => {
        userSettings.set(getId(MediaSegmentType.Intro), MediaSegmentAction.Skip, false);

        expect(getMediaSegmentAction(userSettings, MediaSegmentType.Intro)).toBe(MediaSegmentAction.Skip);
    });

    it('lets a stored preference override a type with no built-in default', () => {
        userSettings.set(getId(MediaSegmentType.Commercial), MediaSegmentAction.AskToSkip, false);

        expect(getMediaSegmentAction(userSettings, MediaSegmentType.Commercial)).toBe(MediaSegmentAction.AskToSkip);
    });

    it('lets a stored "None" preference override a built-in AskToSkip default', () => {
        userSettings.set(getId(MediaSegmentType.Outro), MediaSegmentAction.None, false);

        expect(getMediaSegmentAction(userSettings, MediaSegmentType.Outro)).toBe(MediaSegmentAction.None);
    });
});
