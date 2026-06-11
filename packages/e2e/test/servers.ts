/**
 * Ports/origins shared by `playwright.config.ts` (which boots the
 * servers) and specs that talk to the trunk directly (origin.spec.ts).
 * Non-default ports so a developer's running dev session never collides
 * with the lane.
 */
export const TRUNK_PORT = 3897;
export const WEB_PORT = 5183;
export const TRUNK_ORIGIN = `http://localhost:${TRUNK_PORT}`;
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
