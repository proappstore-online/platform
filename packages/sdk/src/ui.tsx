/**
 * @proappstore/sdk/ui — Full UI component library for Pro apps.
 *
 * Re-exports base primitives (Avatar, SignInButton, ThemeToggle, ProfileMenu)
 * plus Pro-specific components: ProBadge, UpgradeCard, BillingButton,
 * SubscriptionStatus, ProProfilePage.
 */
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { ProAppStore } from './index.js';
import type { User } from '@freeappstore/sdk';
import type { Subscription } from './types.js';
import { useProAuth, useProSubscription, useTheme } from './hooks.js';

// Re-export base primitives
export { Avatar, ThemeToggle } from './ui-primitives.js';
export type { AvatarProps } from './ui-primitives.js';

// ---------------------------------------------------------------------------
// SignInButton (Pro-branded)
// ---------------------------------------------------------------------------

export interface SignInButtonProps {
  app: ProAppStore;
  label?: string;
}

export function SignInButton({ app, label = 'Sign in with GitHub' }: SignInButtonProps) {
  return (
    <button
      onClick={() => app.auth.signIn()}
      style={{
        background: 'var(--accent, #7c3aed)',
        color: '#fff',
        border: 'none',
        padding: '0.6rem 1.5rem',
        borderRadius: 'var(--radius, 0.75rem)',
        fontSize: '0.9rem',
        fontWeight: 700,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ProBadge
// ---------------------------------------------------------------------------

export interface ProBadgeProps {
  size?: 'sm' | 'md' | 'lg';
}

/** Purple "PRO" badge. Shows subscription tier. */
export function ProBadge({ size = 'sm' }: ProBadgeProps) {
  const sizes = {
    sm: { fontSize: '0.6rem', padding: '0.1rem 0.4rem' },
    md: { fontSize: '0.7rem', padding: '0.2rem 0.5rem' },
    lg: { fontSize: '0.8rem', padding: '0.25rem 0.6rem' },
  };
  return (
    <span style={{
      ...sizes[size],
      fontWeight: 700,
      background: 'var(--accent, #7c3aed)',
      color: '#fff',
      borderRadius: '0.25rem',
      textTransform: 'uppercase',
      letterSpacing: '0.03em',
      whiteSpace: 'nowrap',
      display: 'inline-flex',
      alignItems: 'center',
    }}>
      PRO
    </span>
  );
}

// ---------------------------------------------------------------------------
// SubscriptionStatus
// ---------------------------------------------------------------------------

export interface SubscriptionStatusProps {
  app: ProAppStore;
  showUpgrade?: boolean;
}

/** Inline subscription status: PRO badge or "Free" with optional upgrade link. */
export function SubscriptionStatus({ app, showUpgrade = true }: SubscriptionStatusProps) {
  const { subscription, isPro, loading, upgrade } = useProSubscription(app);

  if (loading) {
    return <span style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)' }}>...</span>;
  }

  if (isPro) {
    const renewal = subscription?.cancelAtPeriodEnd
      ? 'Cancels at period end'
      : subscription?.currentPeriodEnd
        ? `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
        : '';
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
        <ProBadge size="md" />
        {renewal && <span style={{ fontSize: '0.75rem', color: 'var(--muted, #64748b)' }}>{renewal}</span>}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <span style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)' }}>Free plan</span>
      {showUpgrade && (
        <button
          onClick={() => upgrade()}
          style={{
            background: 'none',
            border: '1px solid var(--accent, #7c3aed)',
            color: 'var(--accent, #7c3aed)',
            padding: '0.2rem 0.6rem',
            borderRadius: 'var(--radius-sm, 0.5rem)',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Upgrade
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// UpgradeCard
// ---------------------------------------------------------------------------

export interface UpgradeCardProps {
  app: ProAppStore;
  title?: string;
  description?: string;
  priceLabel?: string;
  features?: string[];
}

/** Styled card prompting the user to upgrade to Pro. */
export function UpgradeCard({
  app,
  title = 'Upgrade to Pro',
  description = 'Unlock all premium features with a Pro subscription.',
  priceLabel = '$9/month',
  features = ['Cloud sync across devices', 'AI-powered features', 'Unlimited storage', 'Priority support'],
}: UpgradeCardProps) {
  const { upgrade } = useProSubscription(app);

  return (
    <div style={{
      background: 'var(--surface, #ffffff)',
      border: '1px solid var(--accent, #7c3aed)',
      borderRadius: 'var(--radius, 0.75rem)',
      padding: '1.75rem',
      maxWidth: 400,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--ink-strong, var(--ink, #0f172a))', margin: 0 }}>
          {title}
        </h3>
        <ProBadge size="md" />
      </div>
      <p style={{ fontSize: '0.9rem', color: 'var(--muted, #64748b)', marginBottom: '1rem' }}>{description}</p>
      {features.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.25rem' }}>
          {features.map((f, i) => (
            <li key={i} style={{
              padding: '0.35rem 0',
              fontSize: '0.85rem',
              color: 'var(--ink, #1e293b)',
              borderBottom: '1px solid var(--border, #e2e8f0)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}>
              <span style={{ color: 'var(--accent, #7c3aed)', fontWeight: 700 }}>+</span>
              {f}
            </li>
          ))}
        </ul>
      )}
      <button
        onClick={() => upgrade()}
        style={{
          width: '100%',
          background: 'var(--accent, #7c3aed)',
          color: '#fff',
          border: 'none',
          padding: '0.75rem',
          borderRadius: 'var(--radius, 0.75rem)',
          fontSize: '0.9rem',
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Subscribe — {priceLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BillingButton
// ---------------------------------------------------------------------------

export interface BillingButtonProps {
  app: ProAppStore;
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
}

/** Button that opens the Stripe billing portal. */
export function BillingButton({ app, label = 'Manage billing', variant = 'secondary' }: BillingButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(async () => {
    setLoading(true);
    try {
      await app.subscription.openPortal(window.location.href);
    } catch {} finally {
      setLoading(false);
    }
  }, [app]);

  const baseStyle: React.CSSProperties = {
    padding: '0.6rem 1.25rem',
    borderRadius: 'var(--radius, 0.75rem)',
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: loading ? 'wait' : 'pointer',
    fontFamily: 'inherit',
    opacity: loading ? 0.7 : 1,
  };

  const variants: Record<string, React.CSSProperties> = {
    primary: { ...baseStyle, background: 'var(--accent, #7c3aed)', color: '#fff', border: 'none' },
    secondary: { ...baseStyle, background: 'transparent', color: 'var(--ink, #1e293b)', border: '1px solid var(--border, #e2e8f0)' },
    ghost: { ...baseStyle, background: 'none', color: 'var(--accent, #7c3aed)', border: 'none', padding: '0.4rem 0.75rem' },
  };

  return (
    <button onClick={handleClick} disabled={loading} style={variants[variant]}>
      {loading ? 'Opening...' : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ProfileMenu (Pro-enhanced)
// ---------------------------------------------------------------------------

export interface ProfileMenuProps {
  app: ProAppStore;
  showThemeToggle?: boolean;
  showBilling?: boolean;
  children?: ReactNode;
}

/** Avatar button that opens dropdown with Pro features: badge, billing, theme, sign out. */
export function ProfileMenu({ app, showThemeToggle = true, showBilling = true, children }: ProfileMenuProps) {
  const { user, signOut, deleteAccount } = useProAuth(app);
  const { subscription, isPro, manageBilling } = useProSubscription(app);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!user) return null;

  const handleSignOut = () => { signOut(); setOpen(false); };
  const handleBilling = async () => { await manageBilling(); setOpen(false); };
  const handleDelete = async () => {
    const subClause = subscription?.status === 'active' ? ' and cancels your subscription' : '';
    if (!confirm(`Delete your account? This permanently removes ALL your data across ALL apps${subClause}. This cannot be undone.`)) return;
    if (!confirm('Are you absolutely sure? Last chance.')) return;
    await deleteAccount();
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: '2px solid var(--border, #e2e8f0)',
          borderRadius: '50%',
          padding: 0,
          cursor: 'pointer',
          width: 32,
          height: 32,
          overflow: 'hidden',
          display: 'block',
        }}
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt={user.login} width={28} height={28} style={{ borderRadius: '50%', display: 'block' }} />
        ) : (
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent, #7c3aed)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }}>
            {user.login.charAt(0).toUpperCase()}
          </div>
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 40, right: 0,
          background: 'var(--surface, #ffffff)',
          border: '1px solid var(--border, #e2e8f0)',
          borderRadius: 'var(--radius, 0.75rem)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
          minWidth: 220, padding: '0.5rem 0', zIndex: 100,
        }}>
          {/* Header with name + badge */}
          <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border, #e2e8f0)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <strong style={{ fontSize: '0.85rem', color: 'var(--ink, #1e293b)' }}>{user.login}</strong>
            {isPro && <ProBadge />}
          </div>
          {/* Theme toggle */}
          {showThemeToggle && (
            <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border, #e2e8f0)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)' }}>Theme</span>
              <ThemeToggleInline />
            </div>
          )}
          {/* Billing */}
          {showBilling && isPro && (
            <button onClick={handleBilling} style={menuItemStyle}>Manage billing</button>
          )}
          {/* Extra items */}
          {children}
          <button onClick={handleSignOut} style={menuItemStyle}>Sign out</button>
          <button onClick={handleDelete} style={{ ...menuItemStyle, color: '#dc2626' }}>Delete account</button>
        </div>
      )}
    </div>
  );
}

/** Inline theme toggle for menu (imports from same file to avoid circular) */
function ThemeToggleInline() {
  const { theme, preference, setPreference } = useTheme();
  const cycle = useCallback(() => {
    const order: Array<'system' | 'light' | 'dark'> = ['system', 'light', 'dark'];
    const idx = order.indexOf(preference);
    setPreference(order[(idx + 1) % order.length]!);
  }, [preference, setPreference]);

  const icon = theme === 'dark' ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );

  return (
    <button onClick={cycle} aria-label={`Theme: ${preference}`} style={{
      width: 32, height: 32, borderRadius: 'var(--radius-sm, 0.5rem)',
      border: '1px solid var(--border, #e2e8f0)', background: 'var(--surface, #ffffff)',
      color: 'var(--ink, #1e293b)', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', cursor: 'pointer', padding: 0, fontFamily: 'inherit',
    }}>
      {icon}
    </button>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: '0.5rem 1rem',
  background: 'none', border: 'none', textAlign: 'left',
  fontSize: '0.85rem', cursor: 'pointer',
  color: 'var(--ink, #1e293b)', fontFamily: 'inherit',
};

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
  const { subscription, isPro, loading: subLoading, upgrade, manageBilling } = useProSubscription(app);
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
