/**
 * HTMLRewriter handlers to inject per-app meta tags from app_listings.
 * Rewrites og:description, og:image, twitter:*, meta description, and favicon.
 * Injects missing tags before </head> if the app HTML doesn't include them.
 */

import type { ListingMeta } from "./host.js";

/** Track which meta tags were found so we can inject missing ones. */
class MetaTagTracker {
  readonly found = new Set<string>();
  private listing: ListingMeta;
  constructor(listing: ListingMeta) { this.listing = listing; }

  /** HTML to inject before </head> for any tags not already in the document. */
  missingTagsHtml(): string {
    const parts: string[] = [];
    if (this.listing.tagline) {
      if (!this.found.has("og:description"))
        parts.push(`<meta property="og:description" content="${esc(this.listing.tagline)}">`);
      if (!this.found.has("description"))
        parts.push(`<meta name="description" content="${esc(this.listing.tagline)}">`);
      if (!this.found.has("twitter:description"))
        parts.push(`<meta name="twitter:description" content="${esc(this.listing.tagline)}">`);
    }
    if (this.listing.icon_url) {
      if (!this.found.has("og:image"))
        parts.push(`<meta property="og:image" content="${esc(this.listing.icon_url)}">`);
      if (!this.found.has("twitter:image"))
        parts.push(`<meta name="twitter:image" content="${esc(this.listing.icon_url)}">`);
    }
    return parts.join("\n");
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Rewrite a <meta> tag's content attribute and mark it as found. */
class MetaContentRewriter implements HTMLRewriterElementContentHandlers {
  #value: string;
  #key: string;
  #tracker: MetaTagTracker;
  constructor(value: string, key: string, tracker: MetaTagTracker) {
    this.#value = value;
    this.#key = key;
    this.#tracker = tracker;
  }
  element(el: Element) {
    el.setAttribute("content", this.#value);
    this.#tracker.found.add(this.#key);
  }
}

/** Rewrite <link rel="icon"> href and drop stale type attribute. */
class IconLinkRewriter implements HTMLRewriterElementContentHandlers {
  #url: string;
  constructor(url: string) { this.#url = url; }
  element(el: Element) {
    el.removeAttribute("type");
    el.setAttribute("href", this.#url);
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
export function rewriteMetaTags(response: Response, listing: ListingMeta): Response {
  const tracker = new MetaTagTracker(listing);
  let rewriter = new HTMLRewriter();

  if (listing.tagline) {
    rewriter = rewriter
      .on('meta[property="og:description"]', new MetaContentRewriter(listing.tagline, "og:description", tracker))
      .on('meta[name="description"]', new MetaContentRewriter(listing.tagline, "description", tracker))
      .on('meta[name="twitter:description"]', new MetaContentRewriter(listing.tagline, "twitter:description", tracker));
  }

  if (listing.icon_url) {
    rewriter = rewriter
      .on('meta[property="og:image"]', new MetaContentRewriter(listing.icon_url, "og:image", tracker))
      .on('meta[name="twitter:image"]', new MetaContentRewriter(listing.icon_url, "twitter:image", tracker))
      .on('link[rel="icon"]', new IconLinkRewriter(listing.icon_url));
  }

  // Inject missing tags before </head> closes
  rewriter = rewriter.on("head", new HeadEndInjector(tracker));

  return rewriter.transform(response);
}
