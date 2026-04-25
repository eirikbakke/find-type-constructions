# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Working style

In this repository, Claude should commit its own changes automatically as it works, without waiting to be asked. Each commit should have a descriptive message that explains the motivation for the change, not just the mechanical description of what changed. Group related edits into a single coherent commit rather than committing file-by-file.

After making changes — before reporting a task as done and before committing — always run `npm run check`, which includes `npm run test`. If a change plausibly affects behaviour the tests don't cover, add or extend a test first. A green test suite is part of the definition of "change is complete" in this repo.

**Every bug fix gets a regression test.** When the user reports a bug — even a small one, even an obvious one — add a test that would have caught it before changing any production code. The test should fail on the current (buggy) implementation and pass after the fix. No exceptions. If the bug can't be reproduced, do not invent a fix; report what you observed and ask for more information instead.

## What this project is

A small VSCode extension that adds a command, **Find Type Constructions**, for TypeScript code. Given the interface, type alias, or class under the cursor, it enumerates every place in the program where a value of that type is constructed — both object literals (`{ ... }`) whose contextual type resolves to the symbol, and `new X(...)` expressions whose instance type resolves to the symbol.

## Why it exists

TypeScript is structurally typed, so object literals become values of an interface type implicitly — there is often no syntactic construction marker to find. As a result, VSCode's built-in navigation fails the common refactoring workflow "I'm adding a field to this interface; show me every place I need to update":

- **Find All References** returns every mention of the name — imports, parameter annotations, return-type annotations — and typically misses the actual construction sites entirely. The interface name often appears only at a function's signature, never at the `return` statement that produces the literal.
- **Go to Implementations** is defined only for classes and reports "No implementations found" for interfaces.

The TypeScript checker internally knows the contextual type at every object literal and the instance type of every `new` expression, but tsserver does not expose this. This extension bridges the gap by running its own `ts.Program` over the nearest `tsconfig.json` and querying `checker.getContextualType` at every `ObjectLiteralExpression` and `checker.getTypeAtLocation` at every `NewExpression`.

## Architecture

- `src/extension.ts` — the whole extension. Registers one command, `find-type-constructions.find`.
- The command resolves the symbol under the cursor, verifies it is an `InterfaceDeclaration`, `TypeAliasDeclaration`, or `ClassDeclaration`, then walks every source file in the program. For each `ObjectLiteralExpression` it compares the contextual type's symbol declarations against the target; for each `NewExpression` it does the same with the constructed instance type. The `new`-expression branch is what surfaces constructor-var globals like `ResizeObserver`/`Map`/`Set` (interface merged with a `var` whose value is a constructor) as well as plain class constructions.
- Union and intersection types are walked constituent-by-constituent so literals typed against `Foo | null` still match `Foo`.
- Results are shown via the `editor.action.showReferences` command, which uses VSCode's References panel.

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

Pure logic lives in `src/core.ts` so it can be exercised without a VSCode host. Tests in `src/tests/core.test.ts` use the Node built-in `node:test` runner against fixture TypeScript projects under `src/tests/fixtures/`. The `simple/` fixture covers identity / union / extends-chain matching and error paths; `project-refs/` covers solution-style tsconfigs with `references`; `news/` covers `new`-expression matching of classes and the `ResizeObserver`-style interface-plus-constructor-var merge.

When adding a new behaviour, add a test that pins it. When fixing a bug, add a test that would have caught it.

Configuration lives in `tsconfig.json` (compiler strictness), `eslint.config.mjs` (lint rules and type-aware config), `.prettierrc.json` (formatting), and `.prettierignore`.

Type-aware lint rules require a working `tsconfig.json`; if you add new top-level files that should be linted, include them in `tsconfig.json` or add a scoped ESLint block in `eslint.config.mjs`.

## Design notes and non-goals

- The extension creates its own `ts.Program` rather than going through tsserver, because tsserver does not expose `getContextualType` to clients. This means a second type-check pass runs when the command is invoked; acceptable for an on-demand command.
- Matching follows `extends` chains: a literal typed against a subtype of the cursor interface is reported too, since adding a required field to the base forces every subtype literal to supply it as well.
- Matching is by declaration identity (`Set<ts.Declaration>`), not by name, so interfaces with colliding names in different modules do not cross-contaminate.
