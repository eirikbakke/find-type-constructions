/* eslint-disable @typescript-eslint/no-floating-promises */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import * as fs from "fs";

import {
  findConstructions,
  findTsConfig,
  pathsEqual,
  resolveTsconfigForFile,
} from "../core";

const FIXTURES = path.resolve(__dirname, "fixtures");
const SIMPLE = path.join(FIXTURES, "simple");
const REFS = path.join(FIXTURES, "project-refs");
const NEWS = path.join(FIXTURES, "news");

// Toggle the case of every alphabetic character in a path so we can
// simulate a case-insensitive filesystem handing us mismatched casing.
function mangleCase(p: string): string {
  return p.replace(/[A-Za-z]/g, (ch) =>
    ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()
  );
}

function offsetOfIdentifier(
  file: string,
  declarationLine: string,
  identifier: string
): number {
  const text = fs.readFileSync(file, "utf8");
  const lineStart = text.indexOf(declarationLine);
  if (lineStart < 0) {
    throw new Error(
      `Declaration line ${JSON.stringify(declarationLine)} not in ${file}`
    );
  }
  const inLine = text.indexOf(identifier, lineStart);
  if (inLine < 0) {
    throw new Error(
      `Identifier ${identifier} not found after line '${declarationLine}' in ${file}`
    );
  }
  return inLine;
}

describe("findTsConfig", () => {
  it("finds the nearest tsconfig walking upward", () => {
    const file = path.join(SIMPLE, "uses.ts");
    assert.equal(findTsConfig(file), path.join(SIMPLE, "tsconfig.json"));
  });

  it("returns undefined when no tsconfig exists above", () => {
    assert.equal(findTsConfig("/nonexistent/directory/file.ts"), undefined);
  });
});

describe("resolveTsconfigForFile", () => {
  it("returns the same tsconfig when it already includes the file", () => {
    const tsconfig = path.join(SIMPLE, "tsconfig.json");
    const file = path.join(SIMPLE, "uses.ts");
    assert.equal(resolveTsconfigForFile(tsconfig, file), tsconfig);
  });

  it("walks project references to the sub-tsconfig that includes the file", () => {
    const rootTsconfig = path.join(REFS, "tsconfig.json");
    const file = path.join(REFS, "sub", "types.ts");
    assert.equal(
      resolveTsconfigForFile(rootTsconfig, file),
      path.join(REFS, "sub", "tsconfig.json")
    );
  });

  it("returns undefined if no referenced project includes the file", () => {
    const rootTsconfig = path.join(REFS, "tsconfig.json");
    const outside = path.join(SIMPLE, "uses.ts");
    assert.equal(resolveTsconfigForFile(rootTsconfig, outside), undefined);
  });

  it("matches case-mangled file paths on a case-insensitive filesystem", () => {
    // Regression: on macOS APFS / Windows NTFS (case-insensitive by default),
    // VSCode is free to hand us a path whose casing differs from what
    // `parseJsonConfigFileContent` returns. Exact string comparison made the
    // walk fail for such files, with the misleading "Active file is not
    // included by ..." error. Force `caseSensitive: false` so the test runs
    // identically on Linux CI.
    const rootTsconfig = path.join(REFS, "tsconfig.json");
    const file = path.join(REFS, "sub", "types.ts");
    const mangled = mangleCase(file);
    assert.notEqual(mangled, file, "fixture should actually differ in case");
    assert.equal(
      resolveTsconfigForFile(rootTsconfig, mangled, false),
      path.join(REFS, "sub", "tsconfig.json")
    );
    // And the case-sensitive path still rejects it (sanity check).
    assert.equal(
      resolveTsconfigForFile(rootTsconfig, mangled, true),
      undefined
    );
  });
});

describe("pathsEqual", () => {
  it("compares exactly when caseSensitive is true", () => {
    assert.ok(pathsEqual("/a/b/c.ts", "/a/b/c.ts", true));
    assert.ok(!pathsEqual("/a/b/c.ts", "/A/b/c.ts", true));
  });

  it("ignores case when caseSensitive is false", () => {
    assert.ok(pathsEqual("/a/b/c.ts", "/A/B/C.TS", false));
    assert.ok(!pathsEqual("/a/b/c.ts", "/a/b/d.ts", false));
  });

  it("normalizes redundant path segments before comparing", () => {
    assert.ok(pathsEqual("/a/b/../b/c.ts", "/a/b/c.ts", true));
  });
});

describe("findConstructions — matching", () => {
  const tsconfig = path.join(SIMPLE, "tsconfig.json");
  const typesFile = path.join(SIMPLE, "types.ts");

  it("matches direct identity, union constituents, extends chains, and return literals", () => {
    const offset = offsetOfIdentifier(typesFile, "export interface Foo", "Foo");
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Foo");
    const previews = result.constructions.map((c) => c.preview);

    assert.ok(
      previews.includes("export const directFoo: Foo = { a: 1 };"),
      `missing direct identity match; got: ${previews.join(" | ")}`
    );
    assert.ok(
      previews.includes(
        "export const derivedLiteral: Derived = { a: 2, c: true };"
      ),
      `missing subtype (extends Foo) match; got: ${previews.join(" | ")}`
    );
    assert.ok(
      previews.includes("export const nullableFoo: Foo | null = { a: 3 };"),
      `missing union match; got: ${previews.join(" | ")}`
    );
    assert.ok(
      previews.some((p) => p.includes("return { a: 4 };")),
      `missing return-statement literal; got: ${previews.join(" | ")}`
    );
    // Must not match unrelated interface / type alias literals.
    assert.ok(!previews.some((p) => p.includes("unrelatedLiteral")));
    assert.ok(!previews.some((p) => p.includes("aliasBar")));
  });

  it("matches a type alias", () => {
    const offset = offsetOfIdentifier(typesFile, "export type Bar", "Bar");
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Bar");
    const previews = result.constructions.map((c) => c.preview);
    assert.deepEqual(previews, ['export const aliasBar: Bar = { b: "x" };']);
  });

  it("matches an interface with only one construction site", () => {
    const offset = offsetOfIdentifier(
      typesFile,
      "export interface Unrelated",
      "Unrelated"
    );
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Unrelated");
    assert.equal(result.constructions.length, 1);
  });
});

describe("findConstructions — new-expressions", () => {
  const tsconfig = path.join(NEWS, "tsconfig.json");
  const typesFile = path.join(NEWS, "types.ts");

  it("matches `new` constructions of an interface merged with a constructor var (the ResizeObserver pattern)", () => {
    const offset = offsetOfIdentifier(
      typesFile,
      "export interface Widget",
      "Widget"
    );
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Widget");
    const previews = result.constructions.map((c) => c.preview);
    assert.ok(
      previews.some((p) => p.includes("new Widget(")),
      `missing new-expression match; got: ${previews.join(" | ")}`
    );
    // Must not cross-contaminate with the unrelated Gadget class.
    assert.ok(!previews.some((p) => p.includes("new Gadget(")));
  });

  it("matches `new` constructions of a class declaration", () => {
    const offset = offsetOfIdentifier(
      typesFile,
      "export class Gadget",
      "Gadget"
    );
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Gadget");
    const previews = result.constructions.map((c) => c.preview);
    assert.deepEqual(previews, [
      'export const gadgetConstruction = new Gadget("hello");',
    ]);
  });

  it("returns no results for an interface that is never constructed", () => {
    const offset = offsetOfIdentifier(
      typesFile,
      "export interface Unused",
      "Unused"
    );
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.constructions.length, 0);
  });
});

describe("findConstructions — error paths", () => {
  const tsconfig = path.join(SIMPLE, "tsconfig.json");

  it("reports when the cursor is not on an interface or type alias", () => {
    const usesFile = path.join(SIMPLE, "uses.ts");
    const offset = offsetOfIdentifier(
      usesFile,
      "export const plainNumber",
      "plainNumber"
    );
    const result = findConstructions(tsconfig, usesFile, offset);
    assert.equal(result.kind, "error");
    assert.match(result.message, /not an interface, type alias, or class/);
  });

  it("reports when the file is not part of the program", () => {
    const outside = path.join(REFS, "sub", "types.ts");
    const result = findConstructions(tsconfig, outside, 0);
    assert.equal(result.kind, "error");
    assert.match(result.message, /not part of the program/);
  });

  it("finds the source file when its path differs in case (case-insensitive FS)", () => {
    const typesFile = path.join(SIMPLE, "types.ts");
    const offset = offsetOfIdentifier(typesFile, "export interface Foo", "Foo");
    const mangled = mangleCase(typesFile);
    const result = findConstructions(tsconfig, mangled, offset, false);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Foo");
    assert.ok(result.constructions.length > 0);
  });
});

describe("findConstructions — project references", () => {
  it("operates on a referenced sub-project after resolution", () => {
    const rootTsconfig = path.join(REFS, "tsconfig.json");
    const file = path.join(REFS, "sub", "types.ts");
    const subTsconfig = resolveTsconfigForFile(rootTsconfig, file);
    assert.ok(subTsconfig);

    const offset = offsetOfIdentifier(file, "export interface X", "X");
    const result = findConstructions(subTsconfig, file, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "X");
    assert.equal(result.constructions.length, 1);
    const [first] = result.constructions;
    assert.ok(first);
    assert.ok(first.preview.includes("xLiteral"));
  });
});
