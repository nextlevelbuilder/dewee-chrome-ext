/**
 * Build profiles. One codebase ships as two builds:
 *
 * - `standard` (default): connected browser drives tabs with `chrome.tabs` and the bundled page
 *   script only. No `debugger` permission.
 * - `advanced` (`DEWEE_PROFILE=advanced`): adds the `debugger` permission to the manifest so the
 *   person can opt in, per browser session, to the Chrome DevTools Protocol adapter (accessibility
 *   tree, trusted input, screenshots). The permission is install-time, never optional.
 *
 * `wxt.config.ts` reads the profile and bakes `__DEWEE_ADVANCED__` into the bundle, so the
 * debugger code is dropped from Standard builds.
 */

export type BuildProfile = 'standard' | 'advanced';

/** Manifest permissions every build needs. */
export const BASE_PERMISSIONS = ['sidePanel', 'storage', 'identity', 'alarms', 'scripting'] as const;

/** Unset or empty means Standard; anything else unknown fails the build instead of silently picking one. */
export function profileFromEnv(value: string | undefined): BuildProfile {
  const profile = (value ?? '').trim().toLowerCase();
  if (profile === '' || profile === 'standard') return 'standard';
  if (profile === 'advanced') return 'advanced';
  throw new Error(`Unknown DEWEE_PROFILE "${value}": use "standard" or "advanced"`);
}

export function permissionsFor(profile: BuildProfile): string[] {
  return profile === 'advanced' ? [...BASE_PERMISSIONS, 'debugger'] : [...BASE_PERMISSIONS];
}

export type DeviceCapabilities = ['standard'] | ['standard', 'advanced'];

/**
 * What this browser tells the Gateway it can do. `advanced` is announced only by an Advanced build
 * while the person has the debugger turned on, so the Gateway refuses screenshots up front otherwise.
 */
export function deviceCapabilities(advancedBuild: boolean, debuggerOn: boolean): DeviceCapabilities {
  return advancedBuild && debuggerOn ? ['standard', 'advanced'] : ['standard'];
}

/** True in an Advanced build. Undefined outside a WXT build (unit tests), which counts as Standard. */
export const ADVANCED_BUILD: boolean = typeof __DEWEE_ADVANCED__ !== 'undefined' && __DEWEE_ADVANCED__ === true;
