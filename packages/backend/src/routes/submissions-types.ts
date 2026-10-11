export interface FasUser {
  id: string;
  login: string;
  avatarUrl: string | null;
}

export interface CreateBody {
  appId?: string;
  name?: string;
  category?: string;
  description?: string;
  icon?: string;
  iconBg?: string;
  proFeatures?: string[];
  suggestedMonthlyPriceCents?: number;
  /** #366: only `https://github.com/proappstore-online/<appId>`, the repo the platform provisions and reads. */
  repoUrl?: string;
  /** #366: approved catalogue id (#178) the repo was created from. Omit when unknown. */
  template?: string;
  /** #366: exact template source commit copied (7–40 hex). Requires `template`. */
  templateRev?: string;
}

export interface ApproveBody {
  suggestedMonthlyPriceCents?: number;
}

export interface RejectBody {
  reason?: string;
}
