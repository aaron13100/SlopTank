// SlopTank modification notice: added or changed by SlopTank on 2026-07-21, 2026-09-09.
export const SPLASHSCREEN_URL = '/Branding/Splashscreen';

/**
 * The SlopTank project's own source repository.
 *
 * Every in-product "contribute to this project" affordance must point here. Keeping it in one
 * place is what stops a future upstream merge from quietly restoring one call site to Jellyfin's
 * repository while the others stay correct: there is only ever one call site to restore.
 *
 * This is deliberately NOT the place for links that describe the Jellyfin *server* the client is
 * talking to (help docs, "you need a newer server"). Those genuinely point at Jellyfin and are
 * correct as they are.
 */
export const PROJECT_REPO_URL = 'https://github.com/aaron13100/SlopTank';
