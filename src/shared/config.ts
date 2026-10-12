/** Build-time configuration. `WXT_DEWEE_CLOUD_ORIGIN` overrides the Cloud origin (staging, local CCP). */
export const DEFAULT_CLOUD_ORIGIN: string = import.meta.env.WXT_DEWEE_CLOUD_ORIGIN || 'https://app.dewee.sh';
export const OAUTH_CLIENT_ID = 'dewee-chrome-extension';
export const OAUTH_SCOPE = 'chat workspaces actions';
export const SUPER_AGENT_KEY = 'super-agent';
