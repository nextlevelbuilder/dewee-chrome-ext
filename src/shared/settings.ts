/**
 * Client preferences and connection profiles, kept in `storage.local`. Nothing here is secret:
 * credentials live in `src/auth/credential-store.ts`. Remembered selections are namespaced by
 * profile, then workspace, then agent, so switching never mixes histories.
 */
import { browser } from 'wxt/browser';
import { z } from 'zod';

export const SETTINGS_KEY = 'settings';

const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  kind: z.enum(['cloud', 'gateway']),
  origin: z.string().url(),
  /** Persist the credential across browser restarts (opt-in, disclosed in the UI). */
  remember: z.boolean().default(false),
});
export type Profile = z.infer<typeof profileSchema>;

const workspaceSelection = z.object({
  agentKey: z.string().optional(),
  /** Last open session per agent key. */
  sessions: z.record(z.string(), z.string()).default({}),
});
export type WorkspaceSelection = z.infer<typeof workspaceSelection>;

const profileSelection = z.object({
  workspaceId: z.string().optional(),
  workspaces: z.record(z.string(), workspaceSelection).default({}),
});

export const themes = ['system', 'light', 'dark'] as const;
export const localePrefs = ['auto', 'en', 'vi'] as const;
export type ThemePref = (typeof themes)[number];
export type LocalePref = (typeof localePrefs)[number];

const settingsSchema = z.object({
  version: z.literal(1).default(1),
  profiles: z.array(profileSchema).default([]),
  activeProfileId: z.string().optional(),
  selections: z.record(z.string(), profileSelection).default({}),
  prefs: z
    .object({ theme: z.enum(themes).default('system'), locale: z.enum(localePrefs).default('auto') })
    .default({ theme: 'system', locale: 'auto' }),
});
export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

export async function loadSettings(): Promise<Settings> {
  const stored: unknown = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  const parsed = settingsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : defaultSettings();
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settingsSchema.parse(settings) });
}

let writes: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write helper; returns the saved value. Writes from one page run one after another so
 * two quick changes (a session key and a theme) cannot overwrite each other.
 */
export function updateSettings(change: (current: Settings) => Settings): Promise<Settings> {
  const run = writes.then(async () => {
    const next = change(await loadSettings());
    await saveSettings(next);
    return next;
  });
  writes = run.catch(() => undefined);
  return run;
}

export function activeProfile(settings: Settings): Profile | undefined {
  return settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0];
}

export function workspaceSelectionOf(settings: Settings, profileId: string, workspaceId: string): WorkspaceSelection {
  return settings.selections[profileId]?.workspaces[workspaceId] ?? { sessions: {} };
}

export function withWorkspaceSelection(
  settings: Settings,
  profileId: string,
  workspaceId: string,
  patch: (current: WorkspaceSelection) => WorkspaceSelection,
): Settings {
  const profileSel = settings.selections[profileId] ?? { workspaces: {} };
  const current = profileSel.workspaces[workspaceId] ?? { sessions: {} };
  return {
    ...settings,
    selections: {
      ...settings.selections,
      [profileId]: { ...profileSel, workspaces: { ...profileSel.workspaces, [workspaceId]: patch(current) } },
    },
  };
}

export function withSelectedWorkspace(settings: Settings, profileId: string, workspaceId: string | undefined): Settings {
  const profileSel = settings.selections[profileId] ?? { workspaces: {} };
  return { ...settings, selections: { ...settings.selections, [profileId]: { ...profileSel, workspaceId } } };
}

/** Removes a profile and every remembered selection under it. */
export function withoutProfile(settings: Settings, profileId: string): Settings {
  const { [profileId]: _removed, ...selections } = settings.selections;
  const profiles = settings.profiles.filter((p) => p.id !== profileId);
  return {
    ...settings,
    profiles,
    selections,
    activeProfileId: settings.activeProfileId === profileId ? profiles[0]?.id : settings.activeProfileId,
  };
}

export function newProfileId(): string {
  return `p_${crypto.randomUUID()}`;
}
