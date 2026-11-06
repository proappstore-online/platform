import { Buffer } from 'node:buffer';
import type { GitHub } from '@proappstore/build-core';
import { isTemplateDefaultIcon, renderLettermarkPng } from '@proappstore/compliance/icons';

/** Read binary assets through GitHub; a Worker has no app checkout on disk. */
export async function scaffoldIcons(gh: GitHub, org: string, appId: string, name: string) {
  const files: { path: string; content: string; encoding: 'base64' }[] = [];
  const read = async (path: string): Promise<Buffer | null> => {
    const res = await gh.api(`/repos/${org}/${appId}/contents/${path}?ref=main`);
    if (res.status === 404) return null;
    const data = res.data as { content?: string; encoding?: string };
    if (!res.ok || data?.encoding !== 'base64' || typeof data.content !== 'string') throw new Error(`Could not read icon ${path}`);
    return Buffer.from(data.content.replace(/\s/g, ''), 'base64');
  };
  const marketing = await gh.api(`/repos/${org}/${appId}/contents/marketing?ref=main`);
  if (!marketing.ok && marketing.status !== 404) throw new Error('Could not inspect marketing directory');
  const targets: [string, number][] = [
    ['web/public/icon-192.png', 192], ['web/public/icon-512.png', 512],
    ['web/public/favicon.ico', 192], ['web/public/apple-touch-icon.png', 180],
    ...(marketing.ok ? [['marketing/public/icon-192.png', 192], ['marketing/public/icon-512.png', 512]] as [string, number][] : []),
  ];
  for (const [path, size] of targets) {
    const current = await read(path);
    if (current && ![192, 512].some(s => isTemplateDefaultIcon(s as 192 | 512, current))) continue;
    files.push({ path, content: renderLettermarkPng(name, size).toString('base64'), encoding: 'base64' });
  }
  return files;
}
