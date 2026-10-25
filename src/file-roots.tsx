import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';
import type { FileModule, FileRoot } from '../shared/protocol';
export const defaultRootNames: Record<string, string> = { project: '项目', inputs: '输入文件', outputs: '输出文件', logs: '运行日志' };
const defaults: FileModule[] = Object.entries(defaultRootNames).map(([id, name]) => ({ id, name, folders: [{ id, name, path: '' }] }));
const Context = createContext<{ modules: FileModule[]; roots: FileRoot[]; reload: () => Promise<void>; error: string }>({ modules: defaults, roots: [], reload: async () => {}, error: '' });
export function FileRootsProvider({ children }: { children: React.ReactNode }) {
  const [modules, setModules] = useState(defaults), [error, setError] = useState('');
  const reload = async () => { try { const data = await api<FileModule[]>('/api/file-modules'); setModules(data); setError(''); } catch(e) { setError(String(e)); throw e; } };
  useEffect(() => {
    let live = true;
    const load = () => { if (document.visibilityState === 'hidden') return; void api<FileModule[]>('/api/file-modules').then(data => { if (live) { setModules(data); setError(''); } }).catch(e => { if (live) setError(String(e)); }); };
    load(); const timer = setInterval(load, 30000); window.addEventListener('focus', load); document.addEventListener('visibilitychange', load);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', load); };
  }, []);
  const roots = modules.flatMap(module => module.folders.map(folder => ({ ...folder, moduleId: module.id, moduleName: module.name })));
  return <Context.Provider value={{ modules, roots, reload, error }}>{children}</Context.Provider>;
}
export function useFileModules() { return useContext(Context); }
export function useRootNames() { const { roots } = useFileModules(); return Object.fromEntries(roots.map(root => [root.id, root.moduleName + (root.name !== root.moduleName ? ' · ' + root.name : '')])); }
