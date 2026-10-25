import { Capacitor, registerPlugin } from '@capacitor/core';
import { defaultOrigin } from '../shared/config';
import { loadServers, normalizeOrigin } from '../shared/servers';
interface Credentials { get(options?: { key: string }): Promise<{ token?: string }>; set(options: { token: string; key?: string }): Promise<void>; clear(options?: { key: string }): Promise<void>; }
const secure = registerPlugin<Credentials>('StudioCredentials');
const nativeFiles = registerPlugin<{ download(options: { url: string; filename: string; mime?: string }): Promise<void>; openManager(options: { url: string }): Promise<void> }>('StudioFiles');
export const isNative = Capacitor.isNativePlatform();
const nativeOrigin = import.meta.env.VITE_STUDIO_ORIGIN ? normalizeOrigin(import.meta.env.VITE_STUDIO_ORIGIN) : defaultOrigin;
const initial = loadServers(localStorage, isNative ? nativeOrigin : location.origin);
export let origin = initial.profiles.find(p => p.id === initial.active)!.origin;
let bearer = '';
let generation = 0;
export const getToken = () => bearer;
export async function restoreToken() {
  const key = origin, current = generation;
  let token = isNative ? (await secure.get({ key })).token ?? '' : sessionStorage.getItem('studio.token:' + key) ?? '';
  const legacyOrigin = localStorage.getItem('studio.origin') ?? initial.profiles[0].origin;
  if (!token && !localStorage.getItem('roamdeck.tokenMigrated') && key === legacyOrigin) {
    token = isNative ? (await secure.get()).token ?? '' : sessionStorage.getItem('studio.token') ?? '';
    if (token) { if (isNative) { await secure.set({ key, token }); await secure.clear(); } else sessionStorage.setItem('studio.token:' + key, token); }
    sessionStorage.removeItem('studio.token'); localStorage.setItem('roamdeck.tokenMigrated', '1');
  }
  if (current === generation) bearer = token;
  return current === generation ? token : '';
}
export async function saveToken(token: string, key = origin) {
  if (key === origin) bearer = token;
  if (isNative) { if (token) await secure.set({ key, token }); else await secure.clear({ key }); }
  else if (token) sessionStorage.setItem('studio.token:' + key, token); else sessionStorage.removeItem('studio.token:' + key);
}
export function setOrigin(value: string) {
  const next = normalizeOrigin(value);
  if (next !== origin) { generation++; bearer = ''; }
  origin = next; localStorage.setItem('studio.origin', origin);
}
export async function forgetServer(key: string) { if (isNative) await secure.clear({ key }); sessionStorage.removeItem('studio.token:' + key); }
export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(origin + url, { ...options, credentials: 'include', headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers }, signal: options.signal ?? AbortSignal.timeout(30000) });
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error ?? `请求失败 (${res.status})`); }
  return res.json() as Promise<T>;
}
export const post = <T>(url: string, value: unknown) => api<T>(url, { method: 'POST', body: JSON.stringify(value) });
export async function openExternal(url: string) {
  if (isNative) { const { Browser } = await import('@capacitor/browser'); await Browser.open({ url }); }
  else window.open(url, '_blank', 'noopener');
}
export async function openManager(url: string) { if (isNative) await nativeFiles.openManager({ url }); else window.open(url, '_blank', 'noopener'); }
export async function cloud<T>(url: string, options?: RequestInit): Promise<T> {
  const value = await api<{ data?: T } & T>('/api/cloud' + url, options);
  return value.data ?? value;
}
export async function socket(channel: 'chat' | 'terminal') {
  const address = origin, current = generation;
  const { ticket } = await post<{ ticket: string }>('/api/socket-ticket', { channel });
  if (current !== generation) throw new Error('服务器已切换');
  return new WebSocket(address.replace(/^http/, 'ws') + `/ws/${channel}?ticket=${encodeURIComponent(ticket)}`);
}
export function params(value: { root: string; path: string }) { return new URLSearchParams(value).toString(); }
export async function downloadFile(root: string, path: string) {
  const server = origin;
  const { url } = await post<{ url: string }>('/api/files/preview', { root, path });
  const address = server + url + '?download=1';
  if (isNative) await nativeFiles.download({ url: address, filename: path.split('/').at(-1) ?? 'download' });
  else await openExternal(address);
}
