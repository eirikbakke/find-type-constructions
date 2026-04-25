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
const JSX_PROPS = path.join(FIXTURES, "jsx-props");

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

  it("follows alias chains so the cursor works on import specifiers and other re-exports", () => {
    // Regression: putting the cursor on `RenderContext` in
    //     import { ..., RenderContext } from "./GeneratedBox";
    // or on a type-position reference like
    //     desiredRenderContext: RenderContext;
    // resolved the local ImportSpecifier symbol, not the underlying
    // InterfaceDeclaration. The plugin then refused with "is not an
    // interface, type alias, or class". We now follow alias symbols
    // via `checker.getAliasedSymbol` before deciding.
    const usesFile = path.join(SIMPLE, "uses.ts");
    const offset = offsetOfIdentifier(
      usesFile,
      "import { Foo, Bar, Derived, Unrelated }",
      "Foo"
    );
    const result = findConstructions(tsconfig, usesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Foo");
    const previews = result.constructions.map((c) => c.preview);
    assert.ok(
      previews.includes("export const directFoo: Foo = { a: 1 };"),
      `missing direct match through import alias; got: ${previews.join(" | ")}`
    );
  });

  it("resolves the identifier when the cursor sits exactly at its start (boundary with the previous token)", () => {
    // Regression: in `take<Foo>(...)` the cursor offset for "just left
    // of `Foo`" equals the start of `Foo` and the end of `<`. The token
    // walker visited children in source order and committed to `<`
    // (a punctuation token) before considering the identifier, so the
    // command refused with "Cursor is on a FirstBinaryOperator". Real
    // users hit this when single-clicking at a word boundary. The
    // walker now prefers identifier candidates at boundary positions.
    const file = path.join(SIMPLE, "generics.ts");
    const text = fs.readFileSync(file, "utf8");
    const callLine = text.indexOf("take<Foo>");
    const idStart = text.indexOf("Foo", callLine);
    const result = findConstructions(tsconfig, file, idStart);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Foo");
    // The fixture's call site contains an object-literal construction
    // of Foo via the generic argument.
    const previews = result.constructions.map((c) => c.preview);
    assert.ok(
      previews.some((p) => p.includes("take<Foo>({ a: 99 })")),
      `missing generic-arg construction; got: ${previews.join(" | ")}`
    );
  });

  it("matches `.push({...})` onto a typed array via the element type", () => {
    // Pattern from real codebases (e.g., loops that build a `T[]`):
    // contextual type at the literal flows from
    // `Array<Foo>.push(...items: Foo[])`.
    const offset = offsetOfIdentifier(typesFile, "export interface Foo", "Foo");
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    const previews = result.constructions.map((c) => c.preview);
    assert.ok(
      previews.some((p) => p.includes("fooBucket.push({ a: 6 })")),
      `missing array.push construction; got: ${previews.join(" | ")}`
    );
  });

  it("matches inline elements of an array literal typed `Foo[]`", () => {
    const offset = offsetOfIdentifier(typesFile, "export interface Foo", "Foo");
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    const previews = result.constructions.map((c) => c.preview);
    // Both `{ a: 7 }` and `{ a: 8 }` live on the same line as `fooList`.
    const hits = previews.filter((p) => p.includes("export const fooList:"));
    assert.equal(
      hits.length,
      2,
      `expected 2 array-literal element constructions; got ${hits.length.toString()}: ${previews.join(" | ")}`
    );
  });

  it("matches a literal returned from a generic factory callback (useMemo<Foo>(() => ...) shape)", () => {
    const offset = offsetOfIdentifier(typesFile, "export interface Foo", "Foo");
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    const previews = result.constructions.map((c) => c.preview);
    assert.ok(
      previews.some((p) => p.includes("return { a: 9 };")),
      `missing factory-callback construction; got: ${previews.join(" | ")}`
    );
  });

  it("matches a nested literal whose contextual type comes from a property annotation", () => {
    // The outer literal is a `FooHolder`; the inner `{ a: 10 }` is a
    // `Foo` because of `FooHolder.child: Foo`. Pins that contextual
    // typing flows through nested object positions.
    const offset = offsetOfIdentifier(typesFile, "export interface Foo", "Foo");
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    const previews = result.constructions.map((c) => c.preview);
    assert.ok(
      previews.some((p) => p.includes("child: { a: 10 }")),
      `missing nested-property construction; got: ${previews.join(" | ")}`
    );
  });

  it("resolves the cursor on a type used in a property annotation (use-position, no import indirection)", () => {
    // Distinct from the import-specifier alias-following case: cursor
    // sits on `Foo` inside `interface FooHolder { child: Foo }`. The
    // symbol resolved is the same as if the cursor were on the
    // `interface Foo` declaration, and the same constructions come
    // back.
    const usesFile = path.join(SIMPLE, "uses.ts");
    const offset = offsetOfIdentifier(usesFile, "  child: Foo;", "Foo");
    const result = findConstructions(tsconfig, usesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Foo");
    const previews = result.constructions.map((c) => c.preview);
    assert.ok(previews.includes("export const directFoo: Foo = { a: 1 };"));
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

  it("finds `new Widget(...)` when the cursor is on a type-position annotation referring to the merged symbol (mirrors lib-type cursor: `let r: ResizeObserver = new ResizeObserver(...)` style)", () => {
    const offset = offsetOfIdentifier(
      typesFile,
      "export const widgetTyped: Widget",
      "Widget"
    );
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Widget");
    const previews = result.constructions.map((c) => c.preview);
    assert.ok(previews.some((p) => p.includes("new Widget(")));
  });

  it("finds `new Gadget(...)` when the cursor is on a type-position annotation referring to the class", () => {
    const offset = offsetOfIdentifier(
      typesFile,
      "export const gadgetTyped: Gadget",
      "Gadget"
    );
    const result = findConstructions(tsconfig, typesFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "Gadget");
    const previews = result.constructions.map((c) => c.preview);
    assert.ok(previews.some((p) => p.includes("new Gadget(")));
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

describe("findConstructions — JSX props interfaces", () => {
  const tsconfig = path.join(JSX_PROPS, "tsconfig.json");
  const componentFile = path.join(JSX_PROPS, "Greeting.tsx");
  const usesFile = path.join(JSX_PROPS, "uses.tsx");

  it("matches `<Component .../>` JSX usages as constructions of the props interface", () => {
    // Regression: a React component's `Props` interface is "constructed"
    // syntactically by every JSX call site, but those sites are
    // JsxOpeningElement / JsxSelfClosingElement nodes — not
    // ObjectLiteralExpressions. Walking only object literals missed every
    // JSX construction and reported "No constructions found", which is
    // the most common refactoring case for React components.
    const offset = offsetOfIdentifier(
      componentFile,
      "export interface GreetingProps",
      "GreetingProps"
    );
    const result = findConstructions(tsconfig, componentFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.name, "GreetingProps");
    const previews = result.constructions.map((c) => c.preview);
    // One self-closing usage and one open/close usage.
    assert.equal(
      result.constructions.length,
      2,
      `expected 2 JSX constructions; got: ${previews.join(" | ")}`
    );
    assert.ok(previews.some((p) => p.includes('<Greeting name="Ada"')));
    assert.ok(previews.some((p) => p.includes('<Greeting name="Grace"')));
  });

  it("returns no results for a JSX-style props interface that is never used", () => {
    const offset = offsetOfIdentifier(
      componentFile,
      "export interface UnusedProps",
      "UnusedProps"
    );
    const result = findConstructions(tsconfig, componentFile, offset);
    assert.equal(result.kind, "ok");
    assert.equal(result.constructions.length, 0);
  });

  it("does not double-count: a JSX usage is one construction, not one per attribute", () => {
    const offset = offsetOfIdentifier(
      componentFile,
      "export interface GreetingProps",
      "GreetingProps"
    );
    const result = findConstructions(tsconfig, componentFile, offset);
    assert.equal(result.kind, "ok");
    // Sanity-check uniqueness of the recorded ranges within usesFile.
    const ranges = result.constructions
      .filter((c) => c.file === usesFile)
      .map(
        (c) =>
          `${c.startLine.toString()}:${c.startCharacter.toString()}-${c.endLine.toString()}:${c.endCharacter.toString()}`
      );
    assert.equal(new Set(ranges).size, ranges.length);
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
