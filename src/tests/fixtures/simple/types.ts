export interface Foo {
  a: number;
}

export type Bar = { b: string };

export interface Derived extends Foo {
  c: boolean;
}

export interface Unrelated {
  z: number;
}
