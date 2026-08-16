/**
 * Map errors are shown verbatim to whoever is editing the map, so the parser's
 * job is as much about the message as the validation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MapError, parseMapSource } from './mapFormat.ts';

function rejects(text: string, contains: string): void {
  assert.throws(
    () => parseMapSource(text),
    (e: unknown) => {
      assert.ok(e instanceof MapError, `expected a MapError, got ${e}`);
      assert.ok(
        e.message.toLowerCase().includes(contains.toLowerCase()),
        `message ${JSON.stringify(e.message)} should mention ${JSON.stringify(contains)}`,
      );
      return true;
    },
  );
}

test('a bare grid is a complete map', () => {
  const src = parseMapSource('{ "grid": ["###", "#.#", "###"] }');
  assert.deepEqual(src.grid, ['###', '#.#', '###']);
});

test('ragged rows are padded to the widest', () => {
  const src = parseMapSource('{ "grid": ["#####", "#.#", "#####"] }');
  assert.ok(src.grid.every((r) => r.length === 5));
});

test('malformed input explains itself', () => {
  rejects('not json at all', 'JSON');
  rejects('[]', 'object');
  rejects('{}', 'grid');
  rejects('{ "grid": [] }', 'row');
  rejects('{ "grid": ["##", "##"] }', '3x3');
  rejects('{ "grid": ["###", 5, "###"] }', 'string');
  rejects('{ "grid": ["###","#.#","###"], "spawn": { "x": 1 } }', 'spawn');
  rejects('{ "grid": ["###","#.#","###"], "legend": { "ab": {} } }', 'one character');
  rejects('{ "grid": ["###","#.#","###"], "lights": {} }', 'array');
});

test('a generate block replaces the grid', () => {
  const src = parseMapSource('{ "generate": { "theme": "catacombs", "seed": 7 } }');
  assert.equal(src.generate?.theme, 'catacombs');
  assert.equal(src.generate?.seed, 7);
  assert.deepEqual(src.grid, []);
});

test('generate keeps the rest of the format available', () => {
  const src = parseMapSource('{ "generate": { "theme": "wilds" }, "name": "Home", "exposure": 3 }');
  assert.equal(src.name, 'Home');
  assert.equal(src.exposure, 3);
});

test('a malformed generate block is rejected', () => {
  rejects('{ "generate": {} }', 'theme');
  rejects('{ "generate": { "theme": "wilds", "seed": "x" } }', 'seed');
  rejects('{ "generate": [] }', 'generate');
});
