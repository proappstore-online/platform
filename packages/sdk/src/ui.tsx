/**
 * @proappstore/sdk/ui — Full UI component library for Pro apps.
 *
 * Re-exports base primitives (Avatar, SignInButton, ThemeToggle, ProfileMenu)
 * plus Pro-specific components: ProBadge, UpgradeCard, BillingButton,
 * SubscriptionStatus, ProProfilePage.
 */

// Re-export base primitives
export { Avatar, ThemeToggle, TextSizeToggle } from './ui-primitives.js';
export type { AvatarProps } from './ui-primitives.js';

// Pro-branded primitives + subscription components
export { SignInButton, ProBadge, SubscriptionStatus, UpgradeCard, BillingButton } from './ui-pro-components.js';
export type {
  SignInButtonProps,
  ProBadgeProps,
  SubscriptionStatusProps,
  UpgradeCardProps,
  BillingButtonProps,
} from './ui-pro-components.js';

// ProfileMenu (Pro-enhanced)
export { ProfileMenu } from './ui-profile-menu.js';
export type { ProfileMenuProps } from './ui-profile-menu.js';

// ProProfilePage
export { ProProfilePage } from './ui-profile-page.js';
export type { ProProfilePageProps } from './ui-profile-page.js';

// GateScreen
export { GateScreen } from './ui-gate.js';
export type { GateScreenProps } from './ui-gate.js';

// General-purpose primitives (Button, Card, Input, Modal, Spinner, Tabs, Toast, EmptyState)
export { Button, Card, Input, Spinner, Modal, EmptyState, Tabs, Toast } from './ui-base.js';
export type {
  ButtonProps, ButtonVariant, CardProps, InputProps, SpinnerProps, ModalProps,
  EmptyStateProps, TabItem, TabsProps, ToastProps, ToastVariant,
} from './ui-base.js';
