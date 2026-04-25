import { Foo, Bar, Derived, Unrelated } from "./types";

export const directFoo: Foo = { a: 1 };
export const aliasBar: Bar = { b: "x" };
export const derivedLiteral: Derived = { a: 2, c: true };
export const nullableFoo: Foo | null = { a: 3 };
export const unrelatedLiteral: Unrelated = { z: 9 };

export function makeFoo(): Foo {
  return { a: 4 };
}

export const plainNumber = 5;

// Construction by `.push` onto a typed array — the contextual type at
// the literal comes from the `Foo` element type of the array.
const fooBucket: Foo[] = [];
fooBucket.push({ a: 6 });
export { fooBucket };

// Construction by element-position in an array literal whose target
// type is `Foo[]`.
export const fooList: Foo[] = [{ a: 7 }, { a: 8 }];

// Construction inside a callback whose return type is fixed by an
// outer generic argument — same shape as `useMemo<Foo>(() => ...)`.
declare function compute<T>(factory: () => T): T;
export const computedFoo: Foo = compute<Foo>(() => {
  return { a: 9 };
});

// A property typed as `Foo`. Putting the cursor on `Foo` here is a
// use-position cursor (PropertySignature → TypeReference → Identifier),
// distinct from the import-specifier alias-following case.
export interface FooHolder {
  child: Foo;
}
export const holder: FooHolder = { child: { a: 10 } };
