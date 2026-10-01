// Terminal colour helpers. Plain text when stdout is not a TTY or NO_COLOR=1.
const isTTY = Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== '1';
const ansi = (open: string) => (s: string) => (isTTY ? `\x1b[${open}m${s}\x1b[39m` : s);
export const green = ansi('32');
export const yellow = ansi('33');
export const red = ansi('31');
export const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[22m` : s);
export const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[22m` : s);
