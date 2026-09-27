// Writes dist/shell.css (`@proappstore/sdk/shell.css`, #235/#236) from the
// same sources ProShell and NavBar inject at runtime, so they can never differ.
import { writeFileSync } from 'node:fs';
import { NAVBAR_CSS } from '../dist/navbar-css.js';
import { SHELL_CSS } from '../dist/shell-css.js';

writeFileSync(new URL('../dist/shell.css', import.meta.url), NAVBAR_CSS + SHELL_CSS);
