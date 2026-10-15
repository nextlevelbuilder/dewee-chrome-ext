import { ADVANCED_BUILD, BASE_PERMISSIONS, deviceCapabilities, permissionsFor, profileFromEnv } from '@/shared/build-profile';

describe('build profiles', () => {
  it('defaults to Standard and refuses an unknown profile', () => {
    expect(profileFromEnv(undefined)).toBe('standard');
    expect(profileFromEnv('')).toBe('standard');
    expect(profileFromEnv(' Advanced ')).toBe('advanced');
    expect(() => profileFromEnv('pro')).toThrow(/Unknown DEWEE_PROFILE/);
  });

  it('gives Standard no debugger permission, and Advanced exactly one more', () => {
    expect(permissionsFor('standard')).not.toContain('debugger');
    expect(permissionsFor('standard')).toEqual([...BASE_PERMISSIONS]);
    expect(permissionsFor('advanced')).toEqual([...BASE_PERMISSIONS, 'debugger']);
  });

  it('announces advanced only from an Advanced build with the debugger on', () => {
    expect(deviceCapabilities(false, true)).toEqual(['standard']);
    expect(deviceCapabilities(true, false)).toEqual(['standard']);
    expect(deviceCapabilities(true, true)).toEqual(['standard', 'advanced']);
  });

  it('counts unit tests as a Standard build', () => {
    expect(ADVANCED_BUILD).toBe(false);
  });
});
