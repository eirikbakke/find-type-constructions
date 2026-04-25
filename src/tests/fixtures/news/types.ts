// Mimics the lib.dom.d.ts shape of ResizeObserver: an interface naming the
// instance type, merged with a `var` whose value is a constructor returning
// that interface. Cursor on `Widget` (the interface name) should find the
// `new Widget(...)` site below as a construction.

export interface Widget {
  observe(target: object): void;
}

export declare var Widget: {
  prototype: Widget;
  new (callback: (entries: object[]) => void): Widget;
};

export class Gadget {
  constructor(public name: string) {}
}

export interface Unused {
  marker: true;
}

export const widgetConstruction = new Widget((_entries) => {
  void _entries;
});

export const gadgetConstruction = new Gadget("hello");

// Object-literal construction of a non-constructor interface still works
// alongside the new-expression matching.
export const widgetLikeLiteral: { observe(t: object): void } = {
  observe() {},
};
