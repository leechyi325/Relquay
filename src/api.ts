import { Capacitor, registerPlugin } from '@capacitor/core';
import { defaultOrigin } from '../shared/config';
interface Credentials { get(): Promise<{ token?: string }>; set(options: { token: string }): Promise<void>; clear(): Promise<void>; }
const secure = registerPlugin<Credentials>('StudioCredentials');
const nativeFiles = registerPlugin<{ download(options: { url: string; filename: string; mime?: string }): Promise<void>; openManager(options: { url: string }): Promise<void> }>('StudioFiles');
export const isNative = Capacitor.isNativePlatform();
export let origin = localStorage.getItem('studio.origin') ?? (isNative ? defaultOrigin : location.origin);
let bearer = '';
export const getToken = () => bearer;
export async function restoreToken() { bearer = isNative ? (await secure.get()).token ?? '' : sessionStorage.getItem('studio.token') ?? ''; return bearer; }
export async function saveToken(token: string) {
  bearer = token;
  if (isNative) { if (token) await secure.set({ token }); else await secure.clear(); }
  else if (token) sessionStorage.setItem('studio.token', token); else sessionStorage.removeItem('studio.token');
}
export function setOrigin(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '10.0.2.2'].includes(parsed.hostname))) throw new Error('请使用 HTTPS 服务器地址');
  origin = parsed.origin; localStorage.setItem('studio.origin', origin);
}
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
  const { ticket } = await post<{ ticket: string }>('/api/socket-ticket', { channel });
  return new WebSocket(origin.replace(/^http/, 'ws') + `/ws/${channel}?ticket=${encodeURIComponent(ticket)}`);
}
export function params(value: { root: string; path: string }) { return new URLSearchParams(value).toString(); }
export async function downloadFile(root: string, path: string) {
  const { url } = await post<{ url: string }>('/api/files/preview', { root, path });
  const address = origin + url + '?download=1';
  if (isNative) await nativeFiles.download({ url: address, filename: path.split('/').at(-1) ?? 'download' });
  else await openExternal(address);
}
