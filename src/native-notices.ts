import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { NoticeTarget } from '../shared/notifications';
export type MonitorConfig = { enabled: boolean; completions: boolean; approvals: boolean; servers: { origin: string; name: string }[] };
export type MonitorStatus = MonitorConfig & { permission: boolean; alertsPermission: boolean; batteryExempt?: boolean; alertsImportance: number; running: boolean; serversStatus: { origin: string; syncedAt?: number; lastAlertAt?: number; error?: string }[]; alerts: { origin: string; eventId: string; type: string }[] };
export const nativeNotices = registerPlugin<{
  status(): Promise<MonitorStatus>;
  configure(config: MonitorConfig): Promise<MonitorStatus>;
  syncServers(options: { servers: { origin: string; name: string }[] }): Promise<void>;
  consumeOpen(options: { eventId: string }): Promise<void>;
  getPendingOpen(): Promise<Partial<NoticeTarget>>;
  openSettings(): Promise<void>;
  openAlertSettings(): Promise<void>;
  openBatterySettings(): Promise<void>;
  testNotification(): Promise<void>;
  addListener(name: 'opened', listener: (target: NoticeTarget) => void): Promise<PluginListenerHandle>;
}>('StudioNotifications');
