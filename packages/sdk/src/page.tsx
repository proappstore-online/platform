import { useEffect, type ReactNode } from 'react';

/**
 * Set the tab title for the current screen (#236, PAS-UI-003). Call it once in
 * each routed screen; the title follows the value while the screen is mounted.
 * Runs after ProShell applies a nav item's `title`, so the screen's own title
 * wins on the same route.
 *
 * ```tsx
 * useDocumentTitle(`${task.title} — Tasks`)
 * ```
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}

export interface PageHeaderProps {
  /** The screen's heading — rendered as its single `<h1>`. */
  title: ReactNode;
  /** Optional line under the heading. */
  description?: ReactNode;
  /** Optional controls aligned with the heading (e.g. a primary button). */
  actions?: ReactNode;
}

/**
 * The screen's heading (#236): renders the page's one `<h1>` the same way on
 * every screen (PAS-UI-003). ProShell moves focus to it after a client-side
 * navigation, so keyboard and screen-reader users land on the new page.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="pas-page-header mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="pas-page-header__title m-0 text-2xl font-bold text-[var(--ink)]" tabIndex={-1} data-pas-page-heading="">
          {title}
        </h1>
        {description && <p className="pas-page-header__description mt-1 text-sm text-[var(--muted)]">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
