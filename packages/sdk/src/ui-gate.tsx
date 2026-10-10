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
  app?: ProAppStore;
  appName?: string | undefined;
  /** Suppress platform advertising while retaining the account and subscription gates. */
  branding?: 'platform' | 'app';
}

/** Renders the appropriate gate screen (loading, sign-in, or upgrade). */
export function GateScreen({ gate, app, appName, branding = 'platform' }: GateScreenProps) {
  if (gate === 'loading') {
    // Neutral while auth (or the subscription) resolves (#241): never sign-in content.
    return (
      <div className="pas-gate-loading" style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p role="status" aria-live="polite" style={{ color: 'var(--muted)' }}>Loading...</p>
      </div>
    );
  }

  if (gate === 'signed-out') {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem', color: 'var(--ink)' }}>
            {appName || (branding === 'platform' ? 'ProAppStore' : 'Sign in')}
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            {branding === 'platform' ? 'Sign in to your ProAppStore account to continue.' : 'Sign in to continue.'}
          </p>
          <SignInButton {...(app ? { app } : {})} />
          {branding === 'platform' && (
            <p style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '0.75rem' }}>
              One account for all Pro apps.
            </p>
          )}
        </div>
      </div>
    );
  }

  // no-subscription
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
      <UpgradeCard
        {...(app ? { app } : {})}
        title={branding === 'platform' ? 'Pro subscription required' : 'Subscription required'}
        description={branding === 'platform'
          ? `${appName || 'This app'} requires an active ProAppStore subscription.`
          : `${appName || 'This app'} requires an active subscription.`}
        showBadge={branding === 'platform'}
      />
    </div>
  );
}
