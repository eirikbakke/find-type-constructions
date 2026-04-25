// Minimal JSX shim so the fixture doesn't pull in React.
declare namespace JSX {
  interface Element {
    readonly _element: true;
  }
  interface IntrinsicElements {
    [tag: string]: unknown;
  }
  interface ElementAttributesProperty {
    props: Record<string, unknown>;
  }
  interface ElementChildrenAttribute {
    children: Record<string, unknown>;
  }
  interface IntrinsicAttributes {
    readonly key?: string | number;
  }
}

declare const React: {
  createElement(
    type: unknown,
    props?: unknown,
    ...children: unknown[]
  ): JSX.Element;
};
