// Writes the package.json version into dist/sdk-version.js (#390). Runs after
// tsc in `build`, and again in `prepack` because publish.yml bumps the version
// after the build and immediately before `pnpm publish`.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../dist/sdk-version.js', import.meta.url);
const source = readFileSync(file, 'utf8');
const stamped = source.replace(/export const SDK_VERSION = '[^']*';/, `export const SDK_VERSION = '${version}';`);
if (!stamped.includes(`'${version}'`)) throw new Error('stamp-version: SDK_VERSION not found in dist/sdk-version.js');
writeFileSync(file, stamped);
