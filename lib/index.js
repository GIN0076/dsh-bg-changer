/**
 * dsh-bg-changer host half.
 *
 * The whole feature lives in the browser half (`./client`): it persists the
 * wallpaper in IndexedDB/localStorage and injects its own stylesheet. This half
 * exists only because a `dsh.client` row is still a Cordis plugin row, so it
 * must be an importable plugin — an empty apply is deliberate and keeps the
 * plugin free of host dependencies (no schemastery, no settings namespace, no
 * HTTP route, no disk access).
 */

/** Cordis plugin name, matching the loader row id. */
export const name = 'bg-changer'

/** Activate the host half: intentionally no host-side behaviour. */
export function apply() {}
