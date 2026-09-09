// SlopTank modification notice: added or changed by SlopTank on 2026-07-21, 2026-09-09.
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { DisplaySettingsValues } from '../types/displaySettingsValues';

import { LocalizationPreferences } from './LocalizationPreferences';

/**
 * Renders the real Display preferences localization section, which is where the user is invited
 * to contribute to the project. SlopTank is a fork; this invitation must lead to SlopTank's own
 * repository, never to Jellyfin's. An upstream merge that restores the original href would send
 * our users to another project's issue tracker, so it is asserted here rather than left to review.
 */
const noop = () => undefined;

const values = {
    language: '',
    dateTimeLocale: ''
} as DisplaySettingsValues;

const renderPreferences = () => render(
    <LocalizationPreferences onChange={noop} values={values} />
);

const getContributeLink = () => screen.queryByRole('link', {
    name: /LearnHowYouCanContribute|Learn how you can contribute/
});

describe('LocalizationPreferences', () => {
    // Vitest is not running with globals, so RTL's automatic cleanup hook is never registered.
    afterEach(cleanup);

    it('points the contribute invitation at the SlopTank repository', () => {
        renderPreferences();

        const link = getContributeLink();

        expect(link).not.toBeNull();
        expect(link?.getAttribute('href')).toBe('https://github.com/aaron13100/SlopTank');
    });

    it('never sends the user to a Jellyfin-owned destination', () => {
        const { baseElement } = renderPreferences();

        const hrefs = Array.from(baseElement.querySelectorAll('a'))
            .map(anchor => anchor.getAttribute('href') ?? '');

        expect(hrefs.length).toBeGreaterThan(0);
        hrefs.forEach(href => {
            expect(href).not.toMatch(/jellyfin\.org|github\.com\/jellyfin/i);
        });
    });
});
