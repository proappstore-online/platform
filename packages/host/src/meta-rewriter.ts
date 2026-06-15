/**
 * HTMLRewriter handlers to inject per-app meta tags from app_listings.
 * Rewrites og:title, og:description, og:image, twitter:* and favicon.
 */

import type { ListingMeta } from "./host.js";

/** Rewrite a <meta> tag's content attribute if a value is provided. */
class MetaContentRewriter implements HTMLRewriterElementContentHandlers {
  #value: string;
  constructor(value: string) { this.#value = value; }
  element(el: Element) { el.setAttribute("content", this.#value); }
}

/** Rewrite <link rel="icon"> href. */
class IconLinkRewriter implements HTMLRewriterElementContentHandlers {
  #url: string;
  constructor(url: string) { this.#url = url; }
  element(el: Element) {
    el.setAttribute("href", this.#url);
    // Remove data URI type — the URL will serve the correct content type
    if (el.getAttribute("href")?.startsWith("data:")) {
      el.removeAttribute("type");
    }
  }
}

/**
 * Apply listing metadata to an HTML response using HTMLRewriter.
 * Only rewrites tags that have a corresponding listing value set.
 */
export function rewriteMetaTags(response: Response, listing: ListingMeta): Response {
  let rewriter = new HTMLRewriter();

  if (listing.tagline) {
    rewriter = rewriter
      .on('meta[property="og:description"]', new MetaContentRewriter(listing.tagline))
      .on('meta[name="description"]', new MetaContentRewriter(listing.tagline))
      .on('meta[name="twitter:description"]', new MetaContentRewriter(listing.tagline));
  }

  if (listing.icon_url) {
    rewriter = rewriter
      .on('meta[property="og:image"]', new MetaContentRewriter(listing.icon_url))
      .on('meta[name="twitter:image"]', new MetaContentRewriter(listing.icon_url))
      .on('link[rel="icon"]', new IconLinkRewriter(listing.icon_url));
  }

  return rewriter.transform(response);
}
