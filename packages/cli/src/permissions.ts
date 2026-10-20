import { resolve } from 'node:path';
import { detectPermissions, fsFileSource, permissionInfo } from '@proappstore/compliance';
import { Command } from 'commander';

/**
 * The browser permissions this app's source uses (#437), by the same detector the
 * platform and `pas check` use. `--json` prints the id list the deploy pipeline
 * reports to the platform for the app's storefront listing.
 */
export async function detectAppPermissions(dir: string): Promise<string[]> {
  const source = fsFileSource(resolve(dir));
  const files: [string, string][] = [];
  for await (const path of source.list()) {
    const text = await source.read(path);
    if (text !== null) files.push([path, text]);
  }
  return detectPermissions(files);
}

export const permissionsCommand = new Command('permissions')
  .description('List the browser permissions this app asks for (camera, microphone, location, …), as its storefront listing shows them.')
  .option('--dir <path>', 'app repo root', '.')
  .option('--json', 'print the permission ids as a JSON array')
  .action(async (opts: { dir: string; json?: boolean }) => {
    const ids = await detectAppPermissions(opts.dir);
    if (opts.json) {
      process.stdout.write(JSON.stringify(ids) + '\n');
      return;
    }
    if (!ids.length) {
      process.stdout.write('No special permissions detected.\n');
      return;
    }
    for (const id of ids) process.stdout.write(`${permissionInfo(id)!.icon}  ${permissionInfo(id)!.name} (${id})\n`);
    process.stdout.write('\nDeclare each with a one-line reason in mcp.json "permissions" so the listing can say why.\n');
  });
