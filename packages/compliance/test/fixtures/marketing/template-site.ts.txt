/**
 * The marketing site's content and settings. Everything the pages say about the
 * app comes from this file: edit the copy, swap in your own images (put them in
 * public/assets/), or change the pages in src/pages/ directly. Keep claims true —
 * no invented pricing, testimonials, customer counts or reviews; leave an optional
 * section empty and it is left out.
 *
 * The Privacy Policy and Terms are a starting point, not legal advice. Review them
 * against what your app actually does before you rely on them.
 */
export const site = {
  appId: 'APPNAME',
  name: 'APPNAME',
  appUrl: 'https://APPNAME.proappstore.online/',
  /** Who runs the app; named as the operator on the legal pages and in the footer. */
  owner: 'The APPNAME team',
  /** Where people can reach you. Leave empty to point them at the app instead. */
  contactEmail: '',
  /** Optional help page or support link shown in the footer. */
  supportUrl: '',
  /** Jurisdiction whose law governs the Terms. Leave empty to omit the clause. */
  governingLaw: '',
  /** Shown on the legal pages; update it whenever you change them. */
  legalUpdated: '2026-10-18',
  /** Brand colours, mapped into the Tailwind theme (bg-accent, text-accent-deep, ...). */
  colors: {
    accent: '#d86f4d',
    /** Buttons and links: dark enough for white text, and for text on paper. */
    accentDeep: '#9f4427',
    accentSoft: '#ffd4bf',
    ink: '#111111',
    muted: '#666666',
    paper: '#ffffff',
    paperDeep: '#f7f7f7',
  },
  headline: 'Explore APPNAME.',
  summary: 'Describe in one or two sentences what APPNAME does and who it is for.',
  ctaLabel: 'Open APPNAME',
  /** Optional hero image, e.g. { src: '/assets/hero.png', alt: '...' }. Without one, a brand-colour panel is shown. */
  heroImage: null as Image | null,
  /** Optional product screenshots, shown in a gallery. */
  screenshots: [] as Image[],
  benefits: [
    { title: 'First benefit', body: 'What someone can do with APPNAME that matters to them.' },
    { title: 'Second benefit', body: 'Another concrete outcome, in plain words.' },
    { title: 'Third benefit', body: 'A third reason to try it.' },
  ],
  howItWorks: [
    { title: 'Open the app', body: 'Go to APPNAME in any modern browser. It installs like an app on phone and desktop.' },
    { title: 'Sign in', body: 'Use your GitHub or Google account. No new password to remember.' },
    { title: 'Get started', body: 'Describe the first thing a new user does.' },
  ],
}

interface Image {
  src: string
  alt: string
}

/** How the legal pages tell people to reach you. */
export const contact = site.contactEmail
  ? `email ${site.contactEmail}`
  : `contact us through ${site.appUrl}`
