/**
 * KLI Studio — application entry
 *
 * Keeps the app-wide side effects (theme class, model catalogue, harness
 * reconnect, global keyboard shortcuts) and hosts the overlays that must sit
 * above the shell: provider settings, command palette and toasts. Layout lives
 * in `<AppShell />`.
 */

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { CommandPalette } from '@/components/CommandPalette';
import { ProviderSettings } from '@/components/ProviderSettings';
import { Toasts } from '@/components/Toasts';
import { useStore } from '@/store';
import { MODES } from '@/types';

export function App() {
  const mode = useStore((state) => state.mode);
  const setMode = useStore((state) => state.setMode);
  const activeProviderId = useStore((state) => state.activeProviderId);
  const activeProviderBaseUrl = useStore(
    (state) => state.providers.find((provider) => provider.id === state.activeProviderId)?.baseUrl,
  );
  const refreshModels = useStore((state) => state.refreshModels);
  const theme = useStore((state) => state.theme);
  const connectHarness = useStore((state) => state.connectHarness);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Load the catalogue of the active provider — FreeLLMAPI on boot, and again
  // whenever the user switches provider (or the provider's base URL changes,
  // which clears the cached models and re-triggers this effect).
  useEffect(() => {
    void refreshModels();
  }, [refreshModels, activeProviderId, activeProviderBaseUrl]);

  // Keep the <html> class in sync with the persisted theme.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(theme);
  }, [theme]);

  // If the user was using the harness last time, reconnect on boot.
  useEffect(() => {
    if (useStore.getState().harnessEnabled) void connectHarness();
  }, [connectHarness]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);

  /** Frozen-mode shortcuts that used to live in the header: ⌘/Ctrl + ← →. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inField = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
      const mod = event.metaKey || event.ctrlKey;

      // Command palette — works everywhere, including inside text fields.
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        useStore.getState().togglePalette();
        return;
      }

      if (inField) return;

      if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        useStore.getState().toggleSidebar();
        return;
      }

      if (!mod || event.key === 'Enter') return;
      const index = MODES.indexOf(mode);
      if (index === -1) return;
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      setMode(MODES[(index + delta + MODES.length) % MODES.length]!);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, setMode]);

  return (
    <>
      <AppShell onOpenSettings={openSettings} />
      <ProviderSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CommandPalette onOpenSettings={openSettings} />
      <Toasts />
    </>
  );
}
