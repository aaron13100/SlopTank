// SlopTank modification notice: added or changed by SlopTank on 2026-07-24, 2026-09-09.
/**
 * Lazy route entry point for permanent item information links.
 * allow-no-test-found: exercised through the info route by e2e/permalink.spec.ts
 */
import React from 'react';

import PermalinkRedirectPage from './PermalinkRedirectPage';

const PermalinkInfo = () => <PermalinkRedirectPage purpose='info' />;

export default PermalinkInfo;
