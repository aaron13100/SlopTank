/**
 * Lazy route entry point for permanent item information links.
 * allow-no-test-found: exercised through the info route by e2e/permalink.spec.ts
 */
import React from 'react';

import PermalinkRedirectPage from './PermalinkRedirectPage';

const PermalinkInfo = () => <PermalinkRedirectPage purpose='info' />;

export default PermalinkInfo;
