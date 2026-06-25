/**
 * @proappstore/sdk/ui — general-purpose UI primitives.
 *
 * Plain styled React components (Button, Card, Input, Modal, Spinner, Tabs,
 * Toast, EmptyState) so agent builds compose the basics instead of re-authoring
 * them every time — fewer tool-loop turns, consistent look across apps.
 *
 * Convention (matches the existing Pro components): inline `style` with CSS-var
 * fallbacks — NO Tailwind dependency, works in any app. Theme by overriding the
 * vars: --accent, --accent-soft, --ink, --muted, --surface, --border, --radius.
 */

import { useEffect, useState, forwardRef, type ReactNode, type CSSProperties, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';

const T = {
  accent: 'var(--accent, #7c3aed)',
  accentSoft: 'var(--accent-soft, #f5f3ff)',
  ink: 'var(--ink, #0f172a)',
  muted: 'var(--muted, #64748b)',
  surface: 'var(--surface, #ffffff)',
  border: 'var(--border, #e2e8f0)',
  radius: 'var(--radius, 0.75rem)',
  danger: 'var(--danger, #dc2626)',
};

// ── Button ───────────────────────────────────────────────────
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, children, style, ...rest },
  ref,
) {
  const base: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
    padding: size === 'sm' ? '0.35rem 0.75rem' : '0.6rem 1.25rem',
    fontSize: size === 'sm' ? '0.8125rem' : '0.875rem',
    fontWeight: 600, borderRadius: T.radius, lineHeight: 1.2,
    cursor: loading || disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1, transition: 'opacity 0.15s, background 0.15s',
  };
  const variants: Record<ButtonVariant, CSSProperties> = {
    primary: { ...base, background: T.accent, color: '#fff', border: 'none' },
    secondary: { ...base, background: 'transparent', color: T.ink, border: `1px solid ${T.border}` },
    ghost: { ...base, background: 'none', color: T.accent, border: 'none' },
    danger: { ...base, background: T.danger, color: '#fff', border: 'none' },
  };
  return (
    <button ref={ref} disabled={loading || disabled} style={{ ...variants[variant], ...style }} {...rest}>
      {loading && <Spinner size={size === 'sm' ? 13 : 15} color="currentColor" />}
      {children}
    </button>
  );
});

// ── Card ─────────────────────────────────────────────────────
export interface CardProps {
  children: ReactNode;
  padding?: string | number;
  style?: CSSProperties;
  onClick?: () => void;
}
export function Card({ children, padding = '1.25rem', style, onClick }: CardProps) {
  return (
    <div onClick={onClick} style={{
      background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius,
      padding, ...(onClick ? { cursor: 'pointer' } : {}), ...style,
    }}>{children}</div>
  );
}

// ── Input ────────────────────────────────────────────────────
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string | null;
}
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, id, style, ...rest }, ref,
) {
  const inputId = id ?? (label ? `in-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      {label && <label htmlFor={inputId} style={{ fontSize: '0.8125rem', fontWeight: 600, color: T.ink }}>{label}</label>}
      <input
        ref={ref} id={inputId}
        aria-invalid={error ? true : undefined}
        style={{
          padding: '0.55rem 0.75rem', fontSize: '0.875rem', color: T.ink,
          background: T.surface, borderRadius: T.radius,
          border: `1px solid ${error ? T.danger : T.border}`, outline: 'none', width: '100%', boxSizing: 'border-box',
          ...style,
        }}
        {...rest}
      />
      {error && <span style={{ fontSize: '0.75rem', color: T.danger }}>{error}</span>}
    </div>
  );
});

// ── Spinner ──────────────────────────────────────────────────
export interface SpinnerProps { size?: number; color?: string }
export function Spinner({ size = 20, color = T.accent }: SpinnerProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Loading" role="status" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray="44" strokeDashoffset="14" opacity="0.9">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

// ── Modal ────────────────────────────────────────────────────
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: string | number;
}
export function Modal({ open, onClose, title, children, width = 440 }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'rgba(0,0,0,0.45)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.surface, borderRadius: T.radius, border: `1px solid ${T.border}`,
        width, maxWidth: '100%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
      }}>
        {title && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem', borderBottom: `1px solid ${T.border}` }}>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: T.ink }}>{title}</h3>
            <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontSize: '1.25rem', lineHeight: 1 }}>×</button>
          </div>
        )}
        <div style={{ padding: '1.25rem' }}>{children}</div>
      </div>
    </div>
  );
}

// ── EmptyState ───────────────────────────────────────────────
export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}
export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.5rem', padding: '2.5rem 1.5rem', color: T.muted }}>
      {icon && <div style={{ opacity: 0.7, marginBottom: '0.25rem' }}>{icon}</div>}
      <p style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: T.ink }}>{title}</p>
      {description && <p style={{ margin: 0, fontSize: '0.85rem', maxWidth: '32ch' }}>{description}</p>}
      {action && <div style={{ marginTop: '0.75rem' }}>{action}</div>}
    </div>
  );
}

// ── Tabs (uncontrolled; renders the active panel) ────────────
export interface TabItem { key: string; label: string; content: ReactNode }
export interface TabsProps { tabs: TabItem[]; defaultTab?: string }
export function Tabs({ tabs, defaultTab }: TabsProps) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.key);
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  return (
    <div>
      <div role="tablist" style={{ display: 'flex', gap: '0.25rem', borderBottom: `1px solid ${T.border}`, marginBottom: '1rem' }}>
        {tabs.map((t) => {
          const on = t.key === current?.key;
          return (
            <button key={t.key} role="tab" aria-selected={on} onClick={() => setActive(t.key)}
              style={{
                padding: '0.5rem 0.85rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                background: 'none', border: 'none', color: on ? T.accent : T.muted,
                borderBottom: `2px solid ${on ? T.accent : 'transparent'}`, marginBottom: '-1px',
              }}>{t.label}</button>
          );
        })}
      </div>
      <div role="tabpanel">{current?.content}</div>
    </div>
  );
}

// ── Toast (controlled; auto-dismiss) ─────────────────────────
export type ToastVariant = 'info' | 'success' | 'error';
export interface ToastProps {
  open: boolean;
  message: string;
  variant?: ToastVariant;
  onClose: () => void;
  duration?: number; // ms; 0 = sticky
}
export function Toast({ open, message, variant = 'info', onClose, duration = 4000 }: ToastProps) {
  useEffect(() => {
    if (!open || duration <= 0) return;
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [open, duration, onClose]);
  if (!open) return null;
  const accentByVariant: Record<ToastVariant, string> = { info: T.accent, success: 'var(--success, #16a34a)', error: T.danger };
  return (
    <div role="status" aria-live="polite" style={{
      position: 'fixed', bottom: '1.25rem', left: '50%', transform: 'translateX(-50%)', zIndex: 1100,
      display: 'flex', alignItems: 'center', gap: '0.75rem', maxWidth: 'calc(100vw - 2rem)',
      padding: '0.7rem 1rem', background: T.ink, color: '#fff', borderRadius: T.radius,
      boxShadow: '0 8px 24px rgba(0,0,0,0.3)', borderLeft: `3px solid ${accentByVariant[variant]}`,
    }}>
      <span style={{ fontSize: '0.875rem' }}>{message}</span>
      <button onClick={onClose} aria-label="Dismiss" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1 }}>×</button>
    </div>
  );
}
