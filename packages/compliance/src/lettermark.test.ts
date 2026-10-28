import { describe, expect, it } from 'vitest';
import { deriveLettermark, lettermarkLabel } from './lettermark.js';

describe('deriveLettermark', () => {
  it.each([
    ['Hiring', 'H'],
    ['hiring', 'H'],
    ['DoorDrop', 'DD'],
    ['doorDrop', 'DD'],
    ['Door Drop', 'DD'],
    ['door-drop', 'DD'],
    ['door_drop', 'DD'],
    ['  door   drop  ', 'DD'],
    ['Door.Drop!', 'DD'],
    ["Joe's Chess", 'JC'],
    ['Pro App Store', 'PA'],
    ['The Book of Hours', 'BH'],
    ['HTTPServer', 'HS'],
    ['Élan', 'E'],
    ['2fast', '2'],
    ['!!!', 'A'],
    ['', 'A'],
  ])('%s -> %s', (name, expected) => {
    expect(deriveLettermark(name)).toBe(expected);
  });

  it('never yields three letters, so the "PAS" template placeholder cannot collide with an app', () => {
    for (const n of ['Pro App Store', 'P A S', 'PAS', 'Platform App Store']) expect(deriveLettermark(n).length).toBeLessThanOrEqual(2);
  });
});

describe('lettermarkLabel', () => {
  it('exposes the full app name', () => {
    expect(lettermarkLabel('Door Drop')).toBe('Door Drop app icon');
    expect(lettermarkLabel('')).toBe('App app icon');
  });
});
