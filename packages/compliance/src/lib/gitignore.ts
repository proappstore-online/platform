/**
 * A `.gitignore` matcher, hand-written and dependency-free (#122).
 *
 * Why this exists: the walker used to filter directories against a hardcoded
 * SKIP_DIRS list, so generated-but-git-ignored artefacts were scanned as if a
 * developer had written them. The worst offenders are HTML reports
 * (`.vibe-check/`, `playwright-report/`, `coverage/`) because they inline CSS
 * custom properties and webfonts — exactly what `no-brand-overrides` and
 * `brand-fonts` look for. An app's own ignore file is the best available
 * statement of "this isn't source".
 *
 * Why no dependency: `@proappstore/compliance` has zero runtime dependencies
 * and is consumed by both the CLI and a Workers-bound bundle. Adding one for a
 * few hundred lines of pattern matching is a worse trade than owning it.
 *
 * SUPPORTED: comments and blanks, `\#`/`\!` escapes, trailing-space stripping,
 * `!` negation with last-match-wins, leading `/` anchoring, trailing `/`
 * (directory-only), `*`, `?`, `**` (leading, trailing, and as a whole segment),
 * character classes including `[!...]` negation, and nested `.gitignore` files
 * with deeper files overriding shallower ones.
 *
 * NOT SUPPORTED, deliberately: `.git/info/exclude`, the global
 * `core.excludesFile`, and `.gitattributes`. All of them live outside the tree
 * being scanned or need git itself to resolve.
 *
 * KNOWN LIMIT, inherited from git: ignore rules apply to UNTRACKED files. A
 * file that is already tracked stays tracked even if listed in `.gitignore`, so
 * this is not a sound proxy for "not in the repo". That is why only
 * `fsFileSource` consults it — see the asymmetry note in file-source.ts.
 */

export interface IgnoreRule {
  /** `!pattern` — re-includes a path an earlier rule excluded. */
  negated: boolean;
  /** Pattern ended in `/` — matches directories only. */
  dirOnly: boolean;
  regex: RegExp;
  /** The original line, for debugging a surprising match. */
  source: string;
}

/** Rules from one `.gitignore`, plus where that file lived. */
export interface IgnoreLayer {
  /** POSIX path of the containing directory, relative to the scan root. `''` at root. */
  base: string;
  rules: IgnoreRule[];
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(char: string): string {
  return char.replace(REGEX_SPECIAL, '\\$&');
}

/**
 * Strip trailing spaces, which git ignores unless backslash-escaped. Leading
 * whitespace is significant and is left alone.
 */
function stripTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    // A space is literal when preceded by an odd number of backslashes.
    let backslashes = 0;
    let i = end - 2;
    while (i >= 0 && line[i] === '\\') { backslashes++; i--; }
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

/** Translate a glob body into regex source. Never anchors — the caller does. */
function translate(pattern: string): string {
  let out = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === '*') {
      let j = i;
      while (pattern[j] === '*') j++;
      const isDoubled = j - i >= 2;
      const atSegmentStart = i === 0 || pattern[i - 1] === '/';
      const atSegmentEnd = j >= pattern.length || pattern[j] === '/';

      if (isDoubled && atSegmentStart && atSegmentEnd) {
        if (j >= pattern.length) {
          // Trailing `/**` — everything below this point.
          out += '.*';
          i = j;
        } else {
          // `**/` — zero or more whole directory segments.
          out += '(?:[^/]+/)*';
          i = j + 1;
        }
        continue;
      }
      // `**` that is not a whole segment degrades to `*`, as git does.
      out += '[^/]*';
      i = j;
      continue;
    }

    if (char === '?') { out += '[^/]'; i++; continue; }

    if (char === '[') {
      let j = i + 1;
      if (pattern[j] === '!' || pattern[j] === '^') j++;
      if (pattern[j] === ']') j++; // a `]` first in the class is literal
      while (j < pattern.length && pattern[j] !== ']') j++;
      if (j >= pattern.length) {
        // Unterminated class — git treats the `[` as literal.
        out += '\\[';
        i++;
        continue;
      }
      let cls = pattern.slice(i, j + 1);
      if (cls[1] === '!') cls = `[^${cls.slice(2)}`; // git spells negation `[!…]`
      out += cls;
      i = j + 1;
      continue;
    }

    if (char === '\\') {
      const next = pattern[i + 1];
      if (next !== undefined) { out += escapeLiteral(next); i += 2; continue; }
      out += '\\\\';
      i++;
      continue;
    }

    out += escapeLiteral(char);
    i++;
  }

  return out;
}

/** Parse one `.gitignore` body into ordered rules. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const raw of text.split(/\r?\n/)) {
    let line = stripTrailingSpaces(raw);
    if (line === '' || line.startsWith('#')) continue;

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1); // escaped literal `#` / `!`
    }
    if (line === '') continue;

    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === '') continue;

    // A slash anywhere (other than the trailing one already removed) anchors the
    // pattern to the .gitignore's own directory. Otherwise it matches at any depth.
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);

    const body = translate(line);
    rules.push({
      negated,
      dirOnly,
      source: raw,
      regex: new RegExp(anchored ? `^${body}$` : `(?:^|.*/)${body}$`),
    });
  }

  return rules;
}

/**
 * Is `relPath` (POSIX, relative to the scan root) ignored by `layers`?
 *
 * Layers must be ordered shallowest-first. Evaluation is last-match-wins across
 * the whole ordered set, which gives both of git's precedence rules at once:
 * a later line in one file beats an earlier one, and a deeper `.gitignore`
 * beats a shallower one.
 *
 * Note git's rule that a file under an excluded directory cannot be re-included.
 * The walker gets that for free by never descending into an ignored directory.
 */
export function isIgnored(layers: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  // Evaluate each ancestor directory before the path itself. A rule like
  // `.vibe-check/` matches only the directory, yet everything beneath it is
  // ignored too — the walker gets that by not descending, but a direct query
  // for `.vibe-check/report/actions.html` has to reach the same answer, which
  // is what `git check-ignore` reports.
  const segments = relPath.split('/');
  let ignored = false;

  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const partial = segments.slice(0, i + 1).join('/');
    const verdict = matchPath(layers, partial, isLast ? isDir : true);
    if (verdict !== null) ignored = verdict;
    // Git does not allow re-including anything under an excluded directory, so
    // once an ancestor is ignored the answer is settled.
    if (ignored && !isLast) return true;
  }

  return ignored;
}

/** Last-match-wins across all applicable layers, or null if nothing matched. */
function matchPath(layers: IgnoreLayer[], path: string, isDir: boolean): boolean | null {
  let result: boolean | null = null;

  for (const layer of layers) {
    let subject: string;
    if (layer.base === '') {
      subject = path;
    } else if (path.startsWith(`${layer.base}/`)) {
      subject = path.slice(layer.base.length + 1);
    } else {
      continue; // this layer governs a different subtree
    }

    for (const rule of layer.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(subject)) result = !rule.negated;
    }
  }

  return result;
}
