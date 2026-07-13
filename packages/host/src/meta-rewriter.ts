/**
 * HTMLRewriter handlers to inject per-app and tenant meta tags.
 * Rewrites title, Open Graph/Twitter metadata, and app icons. Injects missing
 * tags before </head> if the app HTML doesn't include them.
 */

import type { ListingMeta } from "./host.js";

export interface SocialMeta extends ListingMeta {
  title?: string | null;
}

/** Track which meta tags were found so we can inject missing ones. */
class MetaTagTracker {
  readonly found = new Set<string>();
  private meta: SocialMeta;
  private canonicalUrl: string;
  constructor(meta: SocialMeta, canonicalUrl: string) {
    this.meta = meta;
    this.canonicalUrl = canonicalUrl;
  }

  /** HTML to inject before </head> for any tags not already in the document. */
  missingTagsHtml(): string {
    const parts: string[] = [];
    if (this.meta.title) {
      if (!this.found.has("title"))
        parts.push(`<title>${esc(this.meta.title)}</title>`);
      if (!this.found.has("og:title"))
        parts.push(`<meta property="og:title" content="${esc(this.meta.title)}">`);
      if (!this.found.has("twitter:title"))
        parts.push(`<meta name="twitter:title" content="${esc(this.meta.title)}">`);
    }
    if (this.meta.tagline) {
      if (!this.found.has("og:description"))
        parts.push(`<meta property="og:description" content="${esc(this.meta.tagline)}">`);
      if (!this.found.has("description"))
        parts.push(`<meta name="description" content="${esc(this.meta.tagline)}">`);
      if (!this.found.has("twitter:description"))
        parts.push(`<meta name="twitter:description" content="${esc(this.meta.tagline)}">`);
    }
    const icon = this.meta.icon_url ? absoluteUrl(this.meta.icon_url, this.canonicalUrl) : null;
    if (icon) {
      if (!this.found.has("og:image"))
        parts.push(`<meta property="og:image" content="${esc(icon)}">`);
      if (!this.found.has("twitter:image"))
        parts.push(`<meta name="twitter:image" content="${esc(icon)}">`);
      if (!this.found.has("icon"))
        parts.push(`<link rel="icon" href="${esc(icon)}">`);
      if (!this.found.has("apple-touch-icon"))
        parts.push(`<link rel="apple-touch-icon" href="${esc(icon)}">`);
    }
    if (!this.found.has("og:url"))
      parts.push(`<meta property="og:url" content="${esc(this.canonicalUrl)}">`);
    if (!this.found.has("twitter:card")) {
      const hasShareImage = Boolean(icon) || this.found.has("twitter:image") || this.found.has("og:image");
      parts.push(`<meta name="twitter:card" content="${hasShareImage ? "summary_large_image" : "summary"}">`);
    }
    return parts.join("\n");
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function absoluteUrl(value: string, canonicalUrl: string): string {
  try {
    return new URL(value, canonicalUrl).toString();
  } catch {
    return value;
  }
}

class TitleRewriter implements HTMLRewriterElementContentHandlers {
  #value: string;
  #tracker: MetaTagTracker;
  constructor(value: string, tracker: MetaTagTracker) {
    this.#value = value;
    this.#tracker = tracker;
  }
  element(el: Element) {
    el.setInnerContent(this.#value);
    this.#tracker.found.add("title");
  }
}

/** Rewrite a <meta> tag's content attribute and mark it as found. */
class MetaContentRewriter implements HTMLRewriterElementContentHandlers {
  #value: string;
  #key: string;
  #canonicalUrl: string | null;
  #tracker: MetaTagTracker;
  constructor(value: string, key: string, tracker: MetaTagTracker, canonicalUrl: string | null = null) {
    this.#value = value;
    this.#key = key;
    this.#tracker = tracker;
    this.#canonicalUrl = canonicalUrl;
  }
  element(el: Element) {
    el.setAttribute("content", this.#canonicalUrl ? absoluteUrl(this.#value, this.#canonicalUrl) : this.#value);
    this.#tracker.found.add(this.#key);
  }
}

/** Mark a tag as present without changing it. */
class FoundTagMarker implements HTMLRewriterElementContentHandlers {
  #key: string;
  #tracker: MetaTagTracker;
  constructor(key: string, tracker: MetaTagTracker) {
    this.#key = key;
    this.#tracker = tracker;
  }
  element() {
    this.#tracker.found.add(this.#key);
  }
}

/** Rewrite/normalize image URL meta tags without forcing a new value. */
class MetaUrlRewriter implements HTMLRewriterElementContentHandlers {
  #key: string;
  #canonicalUrl: string;
  #tracker: MetaTagTracker;
  constructor(key: string, canonicalUrl: string, tracker: MetaTagTracker) {
    this.#key = key;
    this.#canonicalUrl = canonicalUrl;
    this.#tracker = tracker;
  }
  element(el: Element) {
    const content = el.getAttribute("content");
    if (content) el.setAttribute("content", absoluteUrl(content, this.#canonicalUrl));
    this.#tracker.found.add(this.#key);
  }
}

/** Rewrite <link rel="...icon..."> href and drop stale type attribute. */
class IconLinkRewriter implements HTMLRewriterElementContentHandlers {
  #url: string | null;
  #key: string;
  #canonicalUrl: string;
  #tracker: MetaTagTracker;
  constructor(url: string | null, key: string, canonicalUrl: string, tracker: MetaTagTracker) {
    this.#url = url;
    this.#key = key;
    this.#canonicalUrl = canonicalUrl;
    this.#tracker = tracker;
  }
  element(el: Element) {
    const next = this.#url ?? el.getAttribute("href");
    if (next) el.setAttribute("href", absoluteUrl(next, this.#canonicalUrl));
    if (this.#url) el.removeAttribute("type");
    this.#tracker.found.add(this.#key);
  }
}

/** Inject any missing meta tags right before </head> closes. */
class HeadEndInjector implements HTMLRewriterElementContentHandlers {
  #tracker: MetaTagTracker;
  constructor(tracker: MetaTagTracker) { this.#tracker = tracker; }
  element(el: Element) {
    // onEndTag fires when </head> is reached — by then all child meta
    // elements have been processed and the tracker knows what exists.
    el.onEndTag((end) => {
      const html = this.#tracker.missingTagsHtml();
      if (html) end.before(html, { html: true });
    });
  }
}

/**
 * Apply listing metadata to an HTML response using HTMLRewriter.
 * Rewrites existing tags and injects any that are missing.
 */
export function rewriteMetaTags(response: Response, meta: SocialMeta, canonicalUrl: string): Response {
  const tracker = new MetaTagTracker(meta, canonicalUrl);
  let rewriter = new HTMLRewriter();

  if (meta.title) {
    rewriter = rewriter
      .on("title", new TitleRewriter(meta.title, tracker))
      .on('meta[property="og:title"]', new MetaContentRewriter(meta.title, "og:title", tracker))
      .on('meta[name="twitter:title"]', new MetaContentRewriter(meta.title, "twitter:title", tracker));
  } else {
    rewriter = rewriter
      .on("title", new FoundTagMarker("title", tracker))
      .on('meta[property="og:title"]', new FoundTagMarker("og:title", tracker))
      .on('meta[name="twitter:title"]', new FoundTagMarker("twitter:title", tracker));
  }

  if (meta.tagline) {
    rewriter = rewriter
      .on('meta[property="og:description"]', new MetaContentRewriter(meta.tagline, "og:description", tracker))
      .on('meta[name="description"]', new MetaContentRewriter(meta.tagline, "description", tracker))
      .on('meta[name="twitter:description"]', new MetaContentRewriter(meta.tagline, "twitter:description", tracker));
  } else {
    rewriter = rewriter
      .on('meta[property="og:description"]', new FoundTagMarker("og:description", tracker))
      .on('meta[name="description"]', new FoundTagMarker("description", tracker))
      .on('meta[name="twitter:description"]', new FoundTagMarker("twitter:description", tracker));
  }

  const icon = meta.icon_url ? absoluteUrl(meta.icon_url, canonicalUrl) : null;
  if (icon) {
    rewriter = rewriter
      .on('meta[property="og:image"]', new MetaContentRewriter(icon, "og:image", tracker))
      .on('meta[name="twitter:image"]', new MetaContentRewriter(icon, "twitter:image", tracker))
      .on('link[rel="icon"]', new IconLinkRewriter(icon, "icon", canonicalUrl, tracker))
      .on('link[rel="shortcut icon"]', new IconLinkRewriter(icon, "icon", canonicalUrl, tracker))
      .on('link[rel="apple-touch-icon"]', new IconLinkRewriter(icon, "apple-touch-icon", canonicalUrl, tracker));
  } else {
    rewriter = rewriter
      .on('meta[property="og:image"]', new MetaUrlRewriter("og:image", canonicalUrl, tracker))
      .on('meta[name="twitter:image"]', new MetaUrlRewriter("twitter:image", canonicalUrl, tracker))
      .on('link[rel="icon"]', new IconLinkRewriter(null, "icon", canonicalUrl, tracker))
      .on('link[rel="shortcut icon"]', new IconLinkRewriter(null, "icon", canonicalUrl, tracker))
      .on('link[rel="apple-touch-icon"]', new IconLinkRewriter(null, "apple-touch-icon", canonicalUrl, tracker));
  }

  rewriter = rewriter.on('meta[property="og:url"]', new MetaContentRewriter(canonicalUrl, "og:url", tracker));
  rewriter = icon
    ? rewriter.on('meta[name="twitter:card"]', new MetaContentRewriter("summary_large_image", "twitter:card", tracker))
    : rewriter.on('meta[name="twitter:card"]', new FoundTagMarker("twitter:card", tracker));
  rewriter = rewriter.on("head", new HeadEndInjector(tracker));

  return rewriter.transform(response);
}
