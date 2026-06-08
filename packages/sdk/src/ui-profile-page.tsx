/**
 * @proappstore/sdk/ui — ProProfilePage full-page profile/settings.
 */
import { type ReactNode } from 'react';
import type { ProAppStore } from './index.js';
import { useProAuth, useProSubscription, useTheme } from './hooks.js';
import { SignInButton, ProBadge, BillingButton } from './ui-pro-components.js';

// ---------------------------------------------------------------------------
// ProProfilePage
// ---------------------------------------------------------------------------

export interface ProProfilePageProps {
  app: ProAppStore;
  showThemeToggle?: boolean;
}

/** Full-page profile/settings with subscription info, billing, theme, danger zone. */
export function ProProfilePage({ app, showThemeToggle = true }: ProProfilePageProps) {
  const { user, loading, signOut, deleteAccount } = useProAuth(app);
  const { subscription, isPro, loading: subLoading, upgrade } = useProSubscription(app);
  const { preference, setPreference } = useTheme();

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted, #64748b)' }}>Loading...</div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--muted, #64748b)', marginBottom: '1rem' }}>Sign in to view your profile.</p>
        <SignInButton app={app} />
      </div>
    );
  }

  const handleDelete = async () => {
    const subClause = subscription?.status === 'active' ? ' and cancels your subscription' : '';
    if (!confirm(`Delete your account? This permanently removes ALL your data across ALL apps${subClause}. This cannot be undone.`)) return;
    if (!confirm('Are you absolutely sure? Last chance.')) return;
    await deleteAccount();
  };

  const themeOptions: Array<{ value: 'light' | 'dark' | 'system'; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '2rem 1rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem' }}>
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt={user.login} width={64} height={64} style={{ borderRadius: '50%' }} />
        ) : (
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--accent, #7c3aed)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 700 }}>
            {user.login.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--ink-strong, var(--ink, #0f172a))' }}>{user.login}</span>
            {isPro && <ProBadge size="md" />}
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)' }}>ProAppStore account</div>
        </div>
      </div>

      {/* Subscription section */}
      <Section title="Subscription">
        {subLoading ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)' }}>Loading...</p>
        ) : isPro ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <ProBadge size="lg" />
              <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--ink, #1e293b)' }}>Active</span>
            </div>
            {subscription?.currentPeriodEnd && (
              <p style={{ fontSize: '0.82rem', color: 'var(--muted, #64748b)', marginBottom: '0.75rem' }}>
                {subscription.cancelAtPeriodEnd ? 'Cancels' : 'Renews'} on {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
            <BillingButton app={app} variant="secondary" />
          </div>
        ) : (
          <div>
            <p style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)', marginBottom: '0.75rem' }}>
              You're on the free plan. Upgrade to unlock all premium features.
            </p>
            <button
              onClick={() => upgrade()}
              style={{
                background: 'var(--accent, #7c3aed)', color: '#fff', border: 'none',
                padding: '0.6rem 1.25rem', borderRadius: 'var(--radius, 0.75rem)',
                fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Upgrade to Pro — $9/mo
            </button>
          </div>
        )}
      </Section>

      {/* Theme preference */}
      {showThemeToggle && (
        <Section title="Appearance">
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {themeOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPreference(opt.value)}
                style={{
                  flex: 1, padding: '0.5rem',
                  borderRadius: 'var(--radius-sm, 0.5rem)',
                  border: preference === opt.value ? '2px solid var(--accent, #7c3aed)' : '1px solid var(--border, #e2e8f0)',
                  background: preference === opt.value ? 'var(--accent-soft, #f5f3ff)' : 'transparent',
                  color: preference === opt.value ? 'var(--accent, #7c3aed)' : 'var(--muted, #64748b)',
                  fontWeight: preference === opt.value ? 700 : 500,
                  fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* Sign out */}
      <button
        onClick={signOut}
        style={{
          width: '100%', padding: '0.75rem',
          borderRadius: 'var(--radius, 0.75rem)',
          border: '1px solid var(--border, #e2e8f0)',
          background: 'var(--surface, #ffffff)',
          color: 'var(--ink, #1e293b)',
          fontSize: '0.9rem', fontWeight: 600,
          cursor: 'pointer', marginBottom: '1.5rem', fontFamily: 'inherit',
        }}
      >
        Sign out
      </button>

      {/* Danger zone */}
      <div style={{ border: '1px solid #fecaca', borderRadius: 'var(--radius, 0.75rem)', padding: '1.25rem' }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#dc2626', marginBottom: '0.5rem' }}>Danger zone</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)', marginBottom: '0.75rem' }}>
          Permanently delete your account and all data across all apps.
          {isPro && ' Your subscription will be cancelled.'}
        </p>
        <button
          onClick={handleDelete}
          style={{
            padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm, 0.5rem)',
            border: '1px solid #dc2626', background: 'transparent',
            color: '#dc2626', fontSize: '0.85rem', fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Delete account
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section helper (internal)
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{
      background: 'var(--surface, #ffffff)',
      border: '1px solid var(--border, #e2e8f0)',
      borderRadius: 'var(--radius, 0.75rem)',
      padding: '1.25rem',
      marginBottom: '1rem',
    }}>
      <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--ink, #1e293b)' }}>{title}</div>
      {children}
    </div>
  );
}
