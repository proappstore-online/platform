/**
 * A staged template's `template.json` (#199) is the catalogue entry the platform
 * copies into packages/build-core/src/template-catalogue.ts once the template is
 * published as its own GitHub repository. Check it against the published schema
 * now, so publication is a copy plus the real `release.source_commit`.
 */
import { readFileSync } from 'node:fs';
import { validate, type Json } from './validate-json-schema.js';

const SCHEMA = JSON.parse(readFileSync(new URL('../../docs/templates/catalogue.schema.json', import.meta.url), 'utf8'));

/** Placeholder `release.source_commit` until the template repository exists and its commit is reviewed. */
export const UNPUBLISHED_COMMIT = '0'.repeat(40);

/** Schema errors for a staged template.json; `$comment` is documentation and is dropped when copied into the catalogue. */
export function stagedTemplateErrors(meta: Record<string, unknown>): string[] {
  const { $comment: _comment, ...entry } = meta;
  return validate({ $ref: '#/$defs/template' }, entry as Json, SCHEMA);
}
