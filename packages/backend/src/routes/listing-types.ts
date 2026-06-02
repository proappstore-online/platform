export interface ListingRow {
  app_id: string;
  icon_url: string | null;
  theme_color: string | null;
  splash_color: string | null;
  tagline: string | null;
  long_description: string | null;
  category: string | null;
  website_url: string | null;
  support_email: string | null;
  support_url: string | null;
  social_twitter: string | null;
  social_github: string | null;
  social_mastodon: string | null;
  social_bluesky: string | null;
  privacy_policy_url: string | null;
  terms_url: string | null;
  screenshots_json: string;
  updated_at: number;
}

export interface ListingDto {
  appId: string;
  iconUrl: string | null;
  themeColor: string | null;
  splashColor: string | null;
  tagline: string | null;
  longDescription: string | null;
  category: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportUrl: string | null;
  socialTwitter: string | null;
  socialGithub: string | null;
  socialMastodon: string | null;
  socialBluesky: string | null;
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
  screenshots: string[];
  updatedAt: number;
}

export interface ListingPatch {
  iconUrl?: string | null;
  themeColor?: string | null;
  splashColor?: string | null;
  tagline?: string | null;
  longDescription?: string | null;
  category?: string | null;
  websiteUrl?: string | null;
  supportEmail?: string | null;
  supportUrl?: string | null;
  socialTwitter?: string | null;
  socialGithub?: string | null;
  socialMastodon?: string | null;
  socialBluesky?: string | null;
  privacyPolicyUrl?: string | null;
  termsUrl?: string | null;
  screenshots?: string[];
}

export function rowToDto(r: ListingRow): ListingDto {
  let screenshots: string[] = [];
  try {
    const parsed = JSON.parse(r.screenshots_json);
    if (Array.isArray(parsed)) screenshots = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    // bad JSON — return empty rather than 500
  }
  return {
    appId: r.app_id,
    iconUrl: r.icon_url,
    themeColor: r.theme_color,
    splashColor: r.splash_color,
    tagline: r.tagline,
    longDescription: r.long_description,
    category: r.category,
    websiteUrl: r.website_url,
    supportEmail: r.support_email,
    supportUrl: r.support_url,
    socialTwitter: r.social_twitter,
    socialGithub: r.social_github,
    socialMastodon: r.social_mastodon,
    socialBluesky: r.social_bluesky,
    privacyPolicyUrl: r.privacy_policy_url,
    termsUrl: r.terms_url,
    screenshots,
    updatedAt: r.updated_at,
  };
}

export function emptyDto(appId: string): ListingDto {
  return {
    appId,
    iconUrl: null,
    themeColor: null,
    splashColor: null,
    tagline: null,
    longDescription: null,
    category: null,
    websiteUrl: null,
    supportEmail: null,
    supportUrl: null,
    socialTwitter: null,
    socialGithub: null,
    socialMastodon: null,
    socialBluesky: null,
    privacyPolicyUrl: null,
    termsUrl: null,
    screenshots: [],
    updatedAt: 0,
  };
}
