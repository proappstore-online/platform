/** Which Stripe identity a billing operation runs under (#519): the platform's one live account, or its
 *  separately-configured test mode. No third value — an app is always in exactly one at a time. */
export type StripeEnv = 'live' | 'test';
