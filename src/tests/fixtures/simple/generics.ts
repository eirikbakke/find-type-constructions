// Fixture for cursor-at-token-boundary behaviour: an identifier that
// follows a punctuation token (`<`) so the cursor position at the start
// of the identifier coincides with the end of the previous token.

import { Foo } from "./types";

declare function take<T>(value: T): void;

export function callIt(): void {
  take<Foo>({ a: 99 });
}
