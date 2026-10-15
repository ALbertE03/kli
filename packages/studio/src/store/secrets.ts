import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { envApiKey } from '@/lib/providers';

interface SecretsState {
  /** providerId → API key. Kept in sessionStorage only, never on disk. */
  keys: Record<string, string>;
  setKey: (providerId: string, key: string) => void;
  clearKey: (providerId: string) => void;
}

export const useSecrets = create<SecretsState>()(
  persist(
    (set) => ({
      keys: {},
      setKey: (providerId, key) =>
        set((state) => {
          const keys = { ...state.keys };
          if (key) keys[providerId] = key;
          else delete keys[providerId];
          return { keys };
        }),
      clearKey: (providerId) =>
        set((state) => {
          const keys = { ...state.keys };
          delete keys[providerId];
          return { keys };
        }),
    }),
    {
      name: 'kli-studio-secrets',
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);

/** Runtime key for a provider: user-entered value first, build-time env second. */
export function resolveApiKey(providerId: string, stored: Record<string, string>): string {
  return stored[providerId] || envApiKey(providerId);
}