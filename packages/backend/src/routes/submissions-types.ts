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
  repoUrl?: string;
}

export interface ApproveBody {
  suggestedMonthlyPriceCents?: number;
}

export interface RejectBody {
  reason?: string;
}
