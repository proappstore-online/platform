import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ProAppStore } from './index.js';
import { describeError } from './logs.js';

// ── Error boundary ──────────────────────────────────────────────

export interface ShellErrorContext {
  error: Error;
  /** Clear the error and render the screen again. */
  reset: () => void;
}

interface BoundaryProps {
  app: ProAppStore;
  renderError: ((ctx: ShellErrorContext) => ReactNode) | undefined;
  /** A change (the current route) clears a caught error, so navigating away recovers. */
  resetKey: string;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
  resetKey: string;
}

/**
 * Catches a render error in the app's content (#236) so one broken screen
 * shows a fallback instead of a white screen. The error is recorded through
 * `app.logs` — an error React catches never reaches `window.onerror`, so the
 * automatic capture would otherwise miss it.
 */
export class ShellErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const described = describeError(error);
    this.props.app.logs.capture('error', 'react.error-boundary', described.message, {
      stack: described.stack,
      componentStack: info.componentStack ?? undefined,
      path: typeof window === 'undefined' ? undefined : window.location.pathname,
    });
  }

  reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.renderError) return this.props.renderError({ error, reset: this.reset });
    return (
      <div role="alert" className="pas-shell-error flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <h1>Something went wrong</h1>
        <p>This screen hit an error and could not be shown. It has been reported. Try again, or use the navigation to go elsewhere.</p>
        <button type="button" className="pas-shell-error__retry min-h-11 rounded-[10px] px-5 font-semibold" onClick={this.reset}>
          Try again
        </button>
      </div>
    );
  }
}

// ── Toasts ──────────────────────────────────────────────────────

export type ShellToastVariant = 'info' | 'success' | 'error';

export interface ToastOptions {
  variant?: ShellToastVariant;
  /** Milliseconds before it dismisses itself; 0 keeps it until dismissed. Default 4000. */
  duration?: number;
}

export interface ToastApi {
  /** Show a message; returns its id. */
  show: (message: string, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

interface QueuedToast {
  id: number;
  message: string;
  variant: ShellToastVariant;
  duration: number;
}

/** At most this many messages at once; the oldest goes first. */
const MAX_TOASTS = 4;

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Raise a message from any screen inside ProShell (#236). Messages appear in
 * the shell's single polite live region.
 *
 * ```tsx
 * const toast = useToast()
 * toast.show('Saved', { variant: 'success' })
 * ```
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ProShell>');
  return api;
}

function ToastItem({ toast, onDismiss }: { toast: QueuedToast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);
  return (
    <div className="pas-toast flex items-center gap-3 rounded-xl text-sm" data-variant={toast.variant}>
      <span>{toast.message}</span>
      <button type="button" className="pas-dismiss min-h-11 min-w-11" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
        ×
      </button>
    </div>
  );
}

/**
 * The shell's toast queue. The region is rendered once and always, so it is
 * already in the accessibility tree when a message arrives — a live region
 * created together with its first message is often not announced. Items carry
 * no live-region role of their own.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<QueuedToast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback((message: string, options: ToastOptions = {}) => {
    const id = nextId.current++;
    const toast: QueuedToast = { id, message, variant: options.variant ?? 'info', duration: options.duration ?? 4000 };
    setToasts((all) => [...all, toast].slice(-MAX_TOASTS));
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" className="pas-toast-region fixed bottom-5 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

// ── Offline ─────────────────────────────────────────────────────

/** `navigator.onLine`, kept current by the browser's online/offline events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/**
 * A banner under the topbar while the connection is down (#236). Its polite
 * live region is always present, so the change is announced. Dismissible;
 * clears itself on reconnect, and a later drop shows it again.
 */
export function OfflineBanner() {
  const online = useOnline();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (online) setDismissed(false);
  }, [online]);
  return (
    <div role="status" aria-live="polite">
      {!online && !dismissed && (
        <div className="pas-offline flex items-center justify-between gap-3 text-sm">
          <span>You're offline. Changes can't be saved until the connection is back.</span>
          <button type="button" className="pas-dismiss min-h-11 min-w-11" aria-label="Dismiss offline notice" onClick={() => setDismissed(true)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// ── Skip link ───────────────────────────────────────────────────

/** The first focusable element: hidden until focused, moves focus to the shell's `<main id="main">`. */
export function SkipLink({ mainRef }: { mainRef: RefObject<HTMLElement | null> }) {
  return (
    <a
      href="#main"
      className="pas-skip-link"
      onClick={(e) => {
        // Focus directly rather than following the fragment: a hash change is a
        // history navigation, which a router would see as a route change.
        e.preventDefault();
        mainRef.current?.focus();
      }}
    >
      Skip to content
    </a>
  );
}

// ── Route changes: scroll and focus ─────────────────────────────

/**
 * Scroll and focus on client-side route changes (#236). Forward navigation
 * lands at the top; back/forward returns to where that route was left. After
 * either, focus moves to the new screen's PageHeader `<h1>`, else to `<main>`.
 *
 * Only for client-side navigation (`enabled` = the app passed `onNavigate`):
 * with ordinary links every navigation is a page load, and the browser already
 * restores scroll and resets focus — taking scroll restoration over there would
 * break it on the way back.
 *
 * Returns the function to call just before a forward navigation.
 */
export function useRouteChangeEffects(path: string, mainRef: RefObject<HTMLElement | null>, enabled: boolean): () => void {
  const positions = useRef(new Map<string, number>());
  const lastPath = useRef(path);
  const kind = useRef<'push' | 'pop'>('push');

  useEffect(() => {
    if (!enabled) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    // Runs before the re-render the same popstate causes, while the page still
    // shows the route being left.
    const onPop = () => {
      positions.current.set(lastPath.current, window.scrollY);
      kind.current = 'pop';
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.history.scrollRestoration = previous;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || path === lastPath.current) return;
    lastPath.current = path;
    const back = kind.current === 'pop';
    kind.current = 'push';
    // A frame later, so a router that renders the new screen in its own update
    // has committed it before we scroll to it and look for its heading.
    const frame = requestAnimationFrame(() => {
      window.scrollTo(0, back ? positions.current.get(path) ?? 0 : 0);
      const main = mainRef.current;
      const target = main?.querySelector<HTMLElement>('[data-pas-page-heading]') ?? main;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [path, enabled, mainRef]);

  return useCallback(() => {
    positions.current.set(lastPath.current, window.scrollY);
    kind.current = 'push';
  }, []);
}
