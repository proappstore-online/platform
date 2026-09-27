// Writes dist/shell.css (`@proappstore/sdk/shell.css`, #235) from the same
// source NavBar injects at runtime, so the two can never differ.
import { writeFileSync } from 'node:fs';
import { NAVBAR_CSS } from '../dist/navbar-css.js';

writeFileSync(new URL('../dist/shell.css', import.meta.url), NAVBAR_CSS);
