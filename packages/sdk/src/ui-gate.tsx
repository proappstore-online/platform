/**
 * @proappstore/sdk/ui — GateScreen reusable gate UI.
 */
import type { ProAppStore } from './index.js';
import { SignInButton, UpgradeCard } from './ui-pro-components.js';

// ---------------------------------------------------------------------------
// GateScreen (reusable gate UI)
// ---------------------------------------------------------------------------

export interface GateScreenProps {
  gate: 'loading' | 'signed-out' | 'no-subscription';
  app: ProAppStore;
  appName?: string | undefined;
}

/** Renders the appropriate gate screen (loading, sign-in, or upgrade). */
export function GateScreen({ gate, app, appName }: GateScreenProps) {
  if (gate === 'loading') {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--muted, #64748b)' }}>Loading...</p>
      </div>
    );
  }

  if (gate === 'signed-out') {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem', color: 'var(--ink, #1e293b)' }}>
            {appName || 'ProAppStore'}
          </h1>
          <p style={{ color: 'var(--muted, #64748b)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Sign in to your ProAppStore account to continue.
          </p>
          <SignInButton app={app} />
          <p style={{ color: 'var(--muted, #64748b)', fontSize: '0.75rem', marginTop: '0.75rem' }}>
            One account for all Pro apps.
          </p>
        </div>
      </div>
    );
  }

  // no-subscription
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
      <UpgradeCard
        app={app}
        title="Pro subscription required"
        description={`${appName || 'This app'} requires an active ProAppStore subscription.`}
      />
    </div>
  );
}
