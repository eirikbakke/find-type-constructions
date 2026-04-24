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
