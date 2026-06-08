import { createContext, useContext, type ReactNode } from 'react';
import type { ProAppStore } from './index.js';

const ProContext = createContext<ProAppStore | null>(null);

export interface ProProviderProps {
  app: ProAppStore;
  children: ReactNode;
}

/** Provide the SDK instance to all descendant hooks. */
export function ProProvider({ app, children }: ProProviderProps) {
  return <ProContext.Provider value={app}>{children}</ProContext.Provider>;
}

/** Retrieve the SDK instance from context. Throws if used outside ProProvider. */
export function useApp(): ProAppStore {
  const app = useContext(ProContext);
  if (!app) throw new Error('useApp() must be used inside <ProProvider>');
  return app;
}

/**
 * Try to get the SDK instance from context, or fall back to an explicit arg.
 * This lets hooks work both ways:
 *   useAuth()    — from context (standard)
 *   useAuth(app) — explicit (backward compat)
 */
export function resolveApp(explicit?: ProAppStore): ProAppStore {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const fromContext = useContext(ProContext);
  const app = explicit ?? fromContext;
  if (!app) throw new Error('Pass `app` or wrap your app in <ProProvider app={app}>');
  return app;
}
