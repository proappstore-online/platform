/**
 * @proappstore/sdk/ui — Pro-branded primitives and subscription components.
 *
 * SignInButton, ProBadge, SubscriptionStatus, UpgradeCard, BillingButton.
 */
import { useState, useCallback } from 'react';
import type { ProAppStore } from './index.js';
import type { AuthProvider } from './auth.js';
import { useSubscription } from './hooks.js';
import { resolveApp } from './provider.js';

// ---------------------------------------------------------------------------
// SignInButton (Pro-branded)
// ---------------------------------------------------------------------------

export interface SignInButtonProps {
  app?: ProAppStore;
  label?: string;
  provider?: Exclude<AuthProvider, 'email'>;
}

export function SignInButton({
  app: appProp,
  label = 'Sign in with GitHub',
  provider = 'github',
}: SignInButtonProps) {
  const app = resolveApp(appProp);
  return (
    <button
      onClick={() => app.auth.signIn(provider)}
      style={{
        background: 'var(--accent)',
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
      background: 'var(--accent)',
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
  app?: ProAppStore;
  showUpgrade?: boolean;
}

/** Inline subscription status: PRO badge or "Free" with optional upgrade link. */
export function SubscriptionStatus({ app, showUpgrade = true }: SubscriptionStatusProps) {
  const { subscription, isPro, loading, upgrade } = useSubscription(app);

  if (loading) {
    return <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>...</span>;
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
        {renewal && <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{renewal}</span>}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Free plan</span>
      {showUpgrade && (
        <button
          onClick={() => upgrade()}
          style={{
            background: 'none',
            border: '1px solid var(--accent)',
            color: 'var(--accent)',
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
  app?: ProAppStore;
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
  priceLabel = '$5/month',
  features = ['Cloud sync across devices', 'AI-powered features', 'Unlimited storage', 'Priority support'],
}: UpgradeCardProps) {
  const { upgrade } = useSubscription(app);

  return (
    <div style={{
      background: 'var(--panel)',
      border: '1px solid var(--accent)',
      borderRadius: 'var(--radius, 0.75rem)',
      padding: '1.75rem',
      maxWidth: 400,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--ink-strong)', margin: 0 }}>
          {title}
        </h3>
        <ProBadge size="md" />
      </div>
      <p style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '1rem' }}>{description}</p>
      {features.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.25rem' }}>
          {features.map((f, i) => (
            <li key={i} style={{
              padding: '0.35rem 0',
              fontSize: '0.85rem',
              color: 'var(--ink)',
              borderBottom: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700 }}>+</span>
              {f}
            </li>
          ))}
        </ul>
      )}
      <button
        onClick={() => upgrade()}
        style={{
          width: '100%',
          background: 'var(--accent)',
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
  app?: ProAppStore;
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
}

/** Button that opens the Stripe billing portal. */
export function BillingButton({ app: appProp, label = 'Manage billing', variant = 'secondary' }: BillingButtonProps) {
  const app = resolveApp(appProp);
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
    primary: { ...baseStyle, background: 'var(--accent)', color: '#fff', border: 'none' },
    secondary: { ...baseStyle, background: 'transparent', color: 'var(--ink)', border: '1px solid var(--line)' },
    ghost: { ...baseStyle, background: 'none', color: 'var(--accent)', border: 'none', padding: '0.4rem 0.75rem' },
  };

  return (
    <button onClick={handleClick} disabled={loading} style={variants[variant]}>
      {loading ? 'Opening...' : label}
    </button>
  );
}
