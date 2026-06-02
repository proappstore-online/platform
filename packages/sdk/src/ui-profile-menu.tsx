/**
 * @proappstore/sdk/ui — ProfileMenu (Pro-enhanced) avatar dropdown.
 */
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { ProAppStore } from './index.js';
import { useProAuth, useProSubscription, useTheme } from './hooks.js';
import { ProBadge } from './ui-pro-components.js';

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
