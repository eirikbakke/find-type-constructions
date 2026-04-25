# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Working style

In this repository, Claude should commit its own changes automatically as it works, without waiting to be asked. Each commit should have a descriptive message that explains the motivation for the change, not just the mechanical description of what changed. Group related edits into a single coherent commit rather than committing file-by-file.

After making changes — before reporting a task as done and before committing — always run `npm run check`, which includes `npm run test`. If a change plausibly affects behaviour the tests don't cover, add or extend a test first. A green test suite is part of the definition of "change is complete" in this repo.

**Every bug fix gets a regression test.** When the user reports a bug — even a small one, even an obvious one — add a test that would have caught it before changing any production code. The test should fail on the current (buggy) implementation and pass after the fix. No exceptions. If the bug can't be reproduced, do not invent a fix; report what you observed and ask for more information instead.

## What this project is

A small VSCode extension that adds a command, **Find Type Constructions**, for TypeScript code. Given the interface, type alias, or class under the cursor, it enumerates every place in the program where a value of that type is constructed — object literals (`{ ... }`) whose contextual type resolves to the symbol, `new X(...)` expressions whose instance type resolves to the symbol, and `<Component ... />` JSX call sites whose attribute-bag's contextual type resolves to the symbol (so a React component's `Props` interface lights up every JSX usage).

## Why it exists

TypeScript is structurally typed, so object literals become values of an interface type implicitly — there is often no syntactic construction marker to find. As a result, VSCode's built-in navigation fails the common refactoring workflow "I'm adding a field to this interface; show me every place I need to update":

- **Find All References** returns every mention of the name — imports, parameter annotations, return-type annotations — and typically misses the actual construction sites entirely. The interface name often appears only at a function's signature, never at the `return` statement that produces the literal.
- **Go to Implementations** is defined only for classes and reports "No implementations found" for interfaces.

The TypeScript checker internally knows the contextual type at every object literal, the instance type of every `new` expression, and the props type at every JSX call site, but tsserver does not expose this. This extension bridges the gap by running its own `ts.Program` over the nearest `tsconfig.json` and querying the checker at each of those positions.

## Architecture

- `src/extension.ts` — the whole extension. Registers one command, `find-type-constructions.find`, and owns the `Type Constructions` panel view that shows results grouped by file.
- Cursor resolution (in `core.ts`): find the leaf token at the cursor — when the cursor sits exactly between two tokens (e.g., between `<` and an identifier in `useState<Foo>`), prefer the identifier on the right. Then call `getSymbolAtLocation` and follow `Alias` chains via `getAliasedSymbol`, so the command works on a type name anywhere it appears (declaration, import specifier, type annotation, generic argument, `new` call, etc.) — not just on its definition site. The resolved symbol must have at least one `InterfaceDeclaration`, `TypeAliasDeclaration`, or `ClassDeclaration` in `declarations`.
- Source-file walk (per file in the program): for each `ObjectLiteralExpression`, compare the contextual type's symbol declarations against the target set; for each `NewExpression`, do the same with the constructed instance type; for each `JsxOpeningElement`/`JsxSelfClosingElement`, do the same with the contextual type of the attributes node. The `new`-expression branch surfaces constructor-var globals like `ResizeObserver`/`Map`/`Set` (interface merged with a `var` whose value is a constructor) as well as plain class constructions; the JSX branch surfaces `<Component ... />` usages, the most common construction site for a React `Props` interface.
- Union and intersection types are walked constituent-by-constituent so literals typed against `Foo | null` still match `Foo`, and JSX attribute-bag types of shape `IntrinsicAttributes & Props` still match `Props`.
- File-path comparison (used both to pick the right tsconfig from a solution-style `references` set and to find the active source file inside the program) is case-insensitive when `ts.sys.useCaseSensitiveFileNames` is false, since macOS APFS / Windows NTFS may hand us a path whose casing differs from what `parseJsonConfigFileContent` returned.
- Results are rendered into the dedicated `Type Constructions` view (a tree of file → construction nodes); clicking a node opens the file at the matched range.

## Build

```sh
npm install
npm run compile   # tsc -p .
```

Launch an Extension Development Host with **F5** from within VSCode.

## Quality checks

All checks are expected to pass on every commit. Run the full suite with:

```sh
npm run check        # typecheck + lint + format:check + test
```

Or individually:

```sh
npm run typecheck    # tsc --noEmit against ./tsconfig.json (strict mode + extra flags)
npm run lint         # ESLint with typescript-eslint strict + stylistic type-checked rules
npm run lint:fix     # ESLint with --fix applied
npm run format:check # Prettier in check mode
npm run format       # Prettier writing fixes in place
npm run test         # node --test on src/tests/*.test.ts via tsx
```

## Tests

Pure logic lives in `src/core.ts` so it can be exercised without a VSCode host. Tests in `src/tests/core.test.ts` use the Node built-in `node:test` runner against fixture TypeScript projects under `src/tests/fixtures/`:

- `simple/` — identity / union / extends-chain matching, type aliases, return-statement literals, `.push`-onto-typed-array, array-literal elements, generic factory callbacks, nested-property contextual typing, alias-following on import specifiers, cursor-on-use-position annotations, cursor-at-token-boundary resolution, and the cursor-not-on-a-type error path.
- `project-refs/` — solution-style tsconfigs with `references`.
- `news/` — `new`-expression matching of classes and the `ResizeObserver`-style interface-plus-constructor-var merge, including cursor on type-position annotations of both flavours.
- `jsx-props/` — `<Component ... />` JSX usages as constructions of the props interface, with a minimal hand-rolled JSX shim so the fixture doesn't pull in React.

`src/tests/vscodeignore.test.ts` separately pins the packaging rules — see "Packaging gotchas" below.

When adding a new behaviour, add a test that pins it. When fixing a bug, add a test that would have caught it.

When a bug is reproduced from a real-life codebase, the fixture must be a minimal abstraction that captures only the structural pattern at issue — never a copy or near-copy of the user's code. Rename interfaces, properties, components, and variables to neutral names (`Widget`, `Greeting`, `Foo`, etc.); strip every comment, every business detail, every property unrelated to the bug; reduce the example to the smallest construct that still triggers the failure. The user's filenames, type names, and field names should be unrecognizable in the fixture. This keeps tests readable as standalone specifications and avoids accidentally embedding proprietary code in the test suite.

Configuration lives in `tsconfig.json` (compiler strictness), `eslint.config.mjs` (lint rules and type-aware config), `.prettierrc.json` (formatting), and `.prettierignore`.

Type-aware lint rules require a working `tsconfig.json`; if you add new top-level files that should be linted, include them in `tsconfig.json` or add a scoped ESLint block in `eslint.config.mjs`.

## Packaging gotchas

The packaged VSIX bundles its own `typescript` dependency, which loads `lib.dom.d.ts` / `lib.es*.d.ts` from `node_modules/typescript/lib/` at runtime. The `.vscodeignore` glob `**/*.ts` matches `.d.ts` too, so a naïve ignore strips every lib file from the package; the installed extension then runs against a `ts.Program` with no global type table, every contextual type collapses to `any`, and matching silently returns zero results — invisible to the unit tests because they load `typescript` from the dev `node_modules/` (intact). The ignore file re-includes `.d.ts` via `!**/*.d.ts` for exactly this reason. `src/tests/vscodeignore.test.ts` pins this against `lib.dom.d.ts` and friends using the same `minimatch` engine vsce uses.

## Design notes and non-goals

- The extension creates its own `ts.Program` rather than going through tsserver, because tsserver does not expose `getContextualType` to clients. This means a second type-check pass runs when the command is invoked; acceptable for an on-demand command.
- Matching follows `extends` chains: a literal typed against a subtype of the cursor interface is reported too, since adding a required field to the base forces every subtype literal to supply it as well.
- Matching is by declaration identity (`Set<ts.Declaration>`), not by name, so interfaces with colliding names in different modules do not cross-contaminate.
- Only syntactic constructions are surfaced: `ObjectLiteralExpression`, `NewExpression`, and JSX call sites. Factory functions returning a value of the type (`Promise.resolve`, `Array.from`, custom builders) are deliberately ignored — there is no general way to know which calls produce the type without arbitrary domain knowledge, and surfacing every method call whose return type matches would drown out the real constructions.
- String- and number-union type aliases (`type X = "a" | "b"`) report no constructions, because string and number literals are not syntactic constructions of the alias. This is a known and accepted limitation.
