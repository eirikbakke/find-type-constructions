/* eslint-disable @typescript-eslint/no-floating-promises */

// Regression tests for `.vscodeignore`. The packaged extension bundles its
// own `typescript` package and loads `lib.dom.d.ts` / `lib.es*.d.ts` at
// runtime to type-check the user's project. A previous version of the
// ignore file contained the line `**/*.ts`, which silently matched
// declaration files too — the resulting VSIX was missing every lib file,
// `createProgram` returned a program with no global types, every
// contextual type collapsed to `any`, and `findConstructions` reported
// "No constructions found" for every cursor position. The bug was
// invisible to the unit tests (those load `typescript` from
// `node_modules` directly, where the lib files are intact); only the
// packaged extension was broken. These tests pin the ignore patterns
// against the file paths that matter most.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import * as fs from "fs";
import { minimatch } from "minimatch";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function loadPatterns(): string[] {
  const text = fs.readFileSync(path.join(REPO_ROOT, ".vscodeignore"), "utf8");
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

// vsce's packaging follows .gitignore-style semantics: each non-negated
// pattern marks a path as excluded; a later `!`-prefixed pattern can
// re-include it. Walk patterns in order and return the final inclusion
// state for the path. `dot: true` so leading-dot paths are matched.
function isExcluded(filePath: string, patterns: string[]): boolean {
  let excluded = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    if (minimatch(filePath, pattern, { dot: true, matchBase: false })) {
      excluded = !negated;
    }
  }
  return excluded;
}

describe(".vscodeignore", () => {
  const patterns = loadPatterns();

  it("does not strip `lib.dom.d.ts` from the bundled typescript package", () => {
    // Without this file the compiler can't see DOM globals like
    // ResizeObserver, HTMLElement, Element — every browser-typed
    // contextual type becomes `any` in the packaged extension.
    assert.equal(
      isExcluded("node_modules/typescript/lib/lib.dom.d.ts", patterns),
      false
    );
  });

  it("does not strip `lib.es2023.d.ts` (or other lib.*.d.ts files)", () => {
    // The ES lib files supply Array, Map, Promise, etc. Without them
    // every type collapses to `any` because the global type table is
    // empty.
    for (const f of [
      "node_modules/typescript/lib/lib.es2020.d.ts",
      "node_modules/typescript/lib/lib.es2023.d.ts",
      "node_modules/typescript/lib/lib.dom.iterable.d.ts",
    ]) {
      assert.equal(isExcluded(f, patterns), false, `expected ${f} to ship`);
    }
  });

  it("still excludes project-source `.ts` files (no shipping uncompiled source)", () => {
    assert.equal(isExcluded("src/core.ts", patterns), true);
    assert.equal(isExcluded("src/extension.ts", patterns), true);
  });

  it("still ships the compiled `out/*.js` entry points", () => {
    assert.equal(isExcluded("out/extension.js", patterns), false);
    assert.equal(isExcluded("out/core.js", patterns), false);
  });
});
