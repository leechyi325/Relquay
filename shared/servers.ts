export type ServerProfile = { id: string; name: string; origin: string; username: string };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export function normalizeOrigin(value: string) {
  const parsed = new URL(value.trim());
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '10.0.2.2'].includes(parsed.hostname)))) throw new Error('请使用不含账号密码的 HTTPS 服务器地址');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('服务器地址只需域名与端口，不包含路径');
  return parsed.origin;
}
export function loadServers(storage: Storage, fallback: string): { profiles: ServerProfile[]; active: string } {
  let profiles: ServerProfile[] = [];
  try {
    const stored: unknown = JSON.parse(storage.getItem('roamdeck.servers') ?? '[]');
    if (Array.isArray(stored)) for (const item of stored) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.username !== 'string') continue;
      try { const origin = normalizeOrigin(item.origin); if (!profiles.some(p => p.origin === origin)) profiles.push({ id: item.id, name: item.name, username: item.username, origin }); } catch { /* Skip malformed local records. */ }
    }
  } catch { /* Older installs have no profile catalog. */ }
  if (!profiles.length) { const origin = normalizeOrigin(storage.getItem('studio.origin') ?? fallback); profiles = [{ id: 'primary', name: new URL(origin).hostname, origin, username: 'ubuntu' }]; }
  const active = storage.getItem('roamdeck.active');
  return { profiles, active: profiles.some(p => p.id === active) ? active! : profiles[0].id };
}
export function persistServers(storage: Storage, profiles: ServerProfile[], active: string) {
  storage.setItem('roamdeck.servers', JSON.stringify(profiles)); storage.setItem('roamdeck.active', active);
}
