import { createHash } from 'node:crypto';

/**
 * sha256 of the icons the app template has shipped (#505). An icon whose bytes match one of
 * these is the template's, not the owner's: `pas create` and `pas brand icons` may replace it,
 * and `pas check` warns while an app still serves it. Anything else is custom and is never touched.
 *
 *   - the original "F" icons (template-app until #505)
 *   - the neutral "PAS" placeholder template-app ships now (three letters, which
 *     deriveLettermark never produces, so no real app's lettermark can collide with it)
 */
const TEMPLATE_DEFAULT_ICON_SHA256: Record<192 | 512, readonly string[]> = {
  192: [
    '068ce0b22606087c2bf67ee3125a7b18522f2ec95a762f5fe2be104fcacc5384',
    '5115a5755bf951f3e772d9d41d8203258bb44666ccd56763698e9b30a772cb2c',
  ],
  512: [
    'ebe6d029764e050f2d2229d5516dec4d5b7f488ff18961db0c757687247c10a6',
    '13f7625cfa333cfd1d8c873e59d819e2206d6a514f3aff30141f86355cf85709',
  ],
};

export const ICON_SIZES = [192, 512] as const;

/** True when `bytes` are exactly an icon the app template ships for this size. */
export function isTemplateDefaultIcon(size: 192 | 512, bytes: Uint8Array): boolean {
  return TEMPLATE_DEFAULT_ICON_SHA256[size].includes(createHash('sha256').update(bytes).digest('hex'));
}
