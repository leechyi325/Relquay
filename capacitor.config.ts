import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'xyz.leechyi.compileverse', appName: '云渡', webDir: 'dist',
  server: { androidScheme: 'https' },
  android: { backgroundColor: '#F7F2E8', allowMixedContent: false, webContentsDebuggingEnabled: false },
};
export default config;
