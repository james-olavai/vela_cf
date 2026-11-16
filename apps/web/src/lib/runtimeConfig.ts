import developmentConfig from '../../../../firebase-applet-config.json';

declare global { var __VELA_CONFIG__: typeof developmentConfig | undefined; }
const configured = globalThis.__VELA_CONFIG__;
if (!import.meta.env.DEV && (!configured?.projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(configured.projectId) || configured.authDomain !== `${configured.projectId}.firebaseapp.com` || !configured.apiKey || !configured.appId || !configured.firestoreDatabaseId)) {
  throw new Error('应用环境配置缺失，请联系管理员');
}
// Production never falls back to the development project when deployment config is missing.
export const firebaseConfig = import.meta.env.DEV ? configured ?? developmentConfig : configured!;
