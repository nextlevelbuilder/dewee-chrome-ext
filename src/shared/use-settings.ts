/**
 * Settings and connection state shared by the side panel and the options page. Both pages watch
 * `chrome.storage` so a change in one (new profile, sign-out, theme) shows up in the other.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { readCredential } from '@/auth/credential-store';
import { resolveLocale, translator, type Locale, type Translate } from './i18n';
import { loadSettings, SETTINGS_KEY, updateSettings, type Settings, type ThemePref } from './settings';

export function applyTheme(theme: ThemePref, root: HTMLElement = document.documentElement): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export interface SettingsState {
  settings: Settings | null;
  /** Profile ids that currently hold a credential. */
  connected: Set<string>;
  update(change: (current: Settings) => Settings): Promise<Settings>;
  t: Translate;
  locale: Locale;
}

async function readSnapshot(): Promise<{ settings: Settings; connected: Set<string> }> {
  const settings = await loadSettings();
  const ids = await Promise.all(settings.profiles.map(async (p) => ((await readCredential(p.id)) ? p.id : null)));
  return { settings, connected: new Set(ids.filter((id): id is string => id !== null)) };
}

export function useSettings(): SettingsState {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [connected, setConnected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    // Only the latest read may land, so an older slow read never overwrites a newer one.
    let latest = 0;
    const refresh = () => {
      const seq = ++latest;
      void readSnapshot().then((snapshot) => {
        if (!live || seq !== latest) return;
        setSettings(snapshot.settings);
        setConnected(snapshot.connected);
      });
    };
    refresh();
    const listener = (changes: Record<string, unknown>) => {
      if (Object.keys(changes).some((key) => key === SETTINGS_KEY || key.startsWith('credential:'))) refresh();
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      live = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);

  const theme = settings?.prefs.theme ?? 'system';
  useEffect(() => applyTheme(theme), [theme]);

  const locale = resolveLocale(settings?.prefs.locale ?? 'auto');
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const t = useMemo(() => translator(locale), [locale]);

  const update = useCallback(async (change: (current: Settings) => Settings) => {
    const next = await updateSettings(change);
    setSettings(next);
    return next;
  }, []);

  return { settings, connected, update, t, locale };
}
