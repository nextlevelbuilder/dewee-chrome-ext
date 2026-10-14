/** Default name for this browser when it is registered as a Dewee device ("Chrome on Windows"). */
const OS_NAMES: Record<string, string> = { win: 'Windows', mac: 'macOS', linux: 'Linux', cros: 'ChromeOS', android: 'Android', openbsd: 'OpenBSD', fuchsia: 'Fuchsia' };

export async function platformOs(): Promise<string> {
  try {
    return (await chrome.runtime.getPlatformInfo()).os;
  } catch {
    return 'unknown';
  }
}

export function deviceNameFor(os: string): string {
  return `Chrome on ${OS_NAMES[os] ?? os}`;
}
