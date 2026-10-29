import { useEffect, useState } from 'react';
import { registerPlugin } from '@capacitor/core';
import { isNative } from './api';
export type ThemeMode = 'system' | 'light' | 'dark';
const key = 'relquay-theme', colors = { light: '#F7F5EF', dark: '#12171B' };
const nativeTheme = registerPlugin<{ apply(options: { dark: boolean }): Promise<void> }>('StudioTheme');
const query = () => window.matchMedia('(prefers-color-scheme: dark)');
export const storedTheme = (): ThemeMode => { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : 'system'; };
export function applyTheme(mode: ThemeMode) {
  const dark = mode === 'dark' || (mode === 'system' && query().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', colors[dark ? 'dark' : 'light']);
  if (isNative) void nativeTheme.apply({ dark }).catch(() => {});
}
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(storedTheme);
  useEffect(() => {
    applyTheme(mode); const media = query(), listener = () => { if (mode === 'system') applyTheme('system'); };
    media.addEventListener('change', listener); return () => media.removeEventListener('change', listener);
  }, [mode]);
  return [mode, (next: ThemeMode) => { localStorage.setItem(key, next); setMode(next); }] as const;
}
