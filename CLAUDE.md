# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A small VSCode extension that adds a command, **Find Type Constructions**, for TypeScript code. Given the interface or type alias under the cursor, it enumerates every object literal in the program whose contextual type resolves to that symbol.

## Why it exists

TypeScript is structurally typed, so object literals become values of an interface type implicitly — there is no `new Foo(...)` to find. As a result, VSCode's built-in navigation fails the common refactoring workflow "I'm adding a field to this interface; show me every place I need to update":

- **Find All References** returns every mention of the name, not just constructions.
- **Go to Implementations** is defined only for classes and reports "No implementations found" for interfaces.

The TypeScript checker internally knows the contextual type at every object literal, but tsserver does not expose this. This extension bridges the gap by running its own `ts.Program` over the nearest `tsconfig.json` and querying `checker.getContextualType` at every `ObjectLiteralExpression`.

## Architecture

- `src/extension.ts` — the whole extension. Registers one command, `find-type-constructions.find`.
- The command resolves the symbol under the cursor, verifies it is an `InterfaceDeclaration` or `TypeAliasDeclaration`, walks every source file in the program, and for each `ObjectLiteralExpression` compares the contextual type's symbol declarations against the target.
- Union and intersection types are walked constituent-by-constituent so literals typed against `Foo | null` still match `Foo`.
- Results are shown via the `editor.action.showReferences` command, which uses VSCode's References panel.

## Build

```sh
npm install
npm run compile   # tsc -p .
```

Launch an Extension Development Host with **F5** from within VSCode.

## Design notes and non-goals

- The extension creates its own `ts.Program` rather than going through tsserver, because tsserver does not expose `getContextualType` to clients. This means a second type-check pass runs when the command is invoked; acceptable for an on-demand command.
- Only direct type identity is reported. Subtype relationships (literal typed against a type that extends the cursor interface) are deliberately not followed — the common refactoring use case is "places that will need to supply the new field," which tracks identity, not subtyping.
- Matching is by declaration identity (`Set<ts.Declaration>`), not by name, so interfaces with colliding names in different modules do not cross-contaminate.
