import { marketplaceFiles } from './marketplace.ts';
import { realtimeFiles } from './realtime.ts';
import { socialFiles } from './social.ts';
import { organizationFiles } from './organization.ts';
import { dashboardFiles } from './dashboard.ts';

export type TemplateType = 'blank' | 'marketplace' | 'realtime' | 'social' | 'organization' | 'dashboard';

export const TEMPLATE_TYPES: TemplateType[] = ['blank', 'marketplace', 'realtime', 'social', 'organization', 'dashboard'];

export function templateOverlay(slug: string, type: TemplateType): Map<string, string> {
  switch (type) {
    case 'marketplace': return marketplaceFiles(slug);
    case 'realtime': return realtimeFiles(slug);
    case 'social': return socialFiles(slug);
    case 'organization': return organizationFiles(slug);
    case 'dashboard': return dashboardFiles(slug);
    default: return new Map();
  }
}
