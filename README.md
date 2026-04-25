# Find Type Constructions

A VSCode extension for TypeScript. Place the cursor on an interface, type alias, or class — or any reference to one (an import, a type annotation, a generic argument) — and the command reports the places in the project where a value of that type is constructed: object literals assigned to it, `new` expressions, and JSX call sites whose props match.

It addresses two specific gaps in VSCode's built-in navigation: there is no "Go to Implementations" that works for interfaces, and "Find All References" returns every mention of the name (imports, parameter annotations, JSDoc) rather than just the construction sites.

> **Note:** This plugin was written entirely by [Claude Code](https://claude.com/claude-code) under the guidance of Eirik Bakke.

## When it helps

A few situations where this is more convenient than the built-in commands:

- Adding a required field to an interface and needing to update each `{ ... }` literal assigned to it, each function returning one, and each component taking it as props.
- Restructuring a React component's `Props` type and locating each `<MyComponent ... />` usage that needs its attributes updated.
- Listing the `new` sites for a class, including any factories.
- Tracing where a domain type is built up across layers of code, when the construction site isn't where the type is named.

## How it differs from the built-in commands

TypeScript is structurally typed: an object becomes a value of an interface type by having the right shape at an assignment site, with no syntactic construction marker. The built-in commands handle this differently than one might expect:

- **Find All References** (Shift+F12) returns every textual mention of the name — imports, parameter annotations, return-type annotations, JSDoc — and so doesn't directly surface the construction sites. When a function declares its return type as an interface and returns an object literal, the interface name appears only at the function's signature, never at the `return` statement that produces the literal.
- **Go to Implementations** (Cmd+F12) reports "No implementations found" for interfaces. TypeScript tracks implementations only for classes, so interfaces, type aliases, and React `Props` types return nothing.
- **Workspace text search** (Cmd+Shift+F) for `: TypeName` or `<TypeName` finds explicit annotations but not constructions whose type is inferred from context (object literals positioned as function arguments or array elements, JSX call sites, returns from typed functions).

The TypeScript compiler computes the relevant types internally — contextual types at object literals, instance types at `new` expressions, props types at JSX call sites — but tsserver does not expose them. This extension queries the compiler directly.

## What it does

Adds a command, **Find Type Constructions**, that operates on the interface, type alias, or class under the cursor. It loads a `ts.Program` from the nearest `tsconfig.json` (following solution-style `references` to the sub-project that includes the active file) and walks every source file, reporting three kinds of construction sites:

- Every `ObjectLiteralExpression` whose contextual type resolves back to the cursor symbol.
- Every `NewExpression` whose constructed instance type resolves back to the cursor symbol — covering plain class constructions as well as constructor-var globals like `ResizeObserver`, `Map`, and `Set`, where the lib declares an interface merged with a `var` whose value is a constructor.
- Every `<Component ... />` JSX call site whose attribute-bag's contextual type resolves to the cursor symbol — typically the most common construction site for a React component's `Props` interface, since the JSX attributes are not a syntactic object literal.

Results appear in a dedicated **Type Constructions** panel view, grouped by file.

Union and intersection constituents and `extends` chains are walked as well, so a literal typed against `Foo | null` or against a subtype of `Foo` is still reported as a construction of `Foo`. Symbols at the cursor that are aliases (import specifiers, namespace re-exports) are followed to the underlying declaration, so the command works on a type name anywhere it appears — not just on its definition site.

## Usage

1. Put your cursor on a type name. Any reference works: the declaration, an import specifier, a parameter or property annotation, a generic type argument (`useState<X>`), an `as X` cast, or a `new X(...)` call.
2. Run **Find Type Constructions** from the command palette (Cmd+Shift+P) or the editor context menu.
3. Browse hits in the **Type Constructions** panel.

## Installation

This extension is not published to the marketplace. Install it from source:

```sh
# 1. Clone and enter this repo.
git clone <this-repo-url> find-type-constructions
cd find-type-constructions

# 2. Install dependencies and compile.
npm install
npm run compile

# 3. Package into a .vsix.
npm install -g @vscode/vsce   # one-time
vsce package                   # produces find-type-constructions-0.0.1.vsix

# 4. Install into VSCode.
code --install-extension find-type-constructions-0.0.1.vsix
```

Alternatively, install from the VSCode UI: open the Extensions view (Cmd+Shift+X), click the `...` menu in the top-right, choose **Install from VSIX...**, and select the `.vsix` file produced in step 3.

After installation, reload VSCode (Cmd+Shift+P → **Developer: Reload Window**). The command **Find Type Constructions** is then available from the command palette and the editor context menu on `.ts` / `.tsx` files.

## Development

For iterating on the extension itself:

```sh
npm install
npm run compile
```

Then open this folder in VSCode and press **F5** to launch an Extension Development Host with the plugin loaded — no packaging or install needed.

Run the test suite with `npm test` (or `npm run check` for typecheck + lint + format + test in one go).

### Rebuilding and reinstalling

Also only relevant while developing the plugin itself. If you prefer to test changes in your main VSCode (rather than the Extension Development Host launched with F5), rebuild and reinstall the packaged extension:

```sh
npm run compile
# Rebuild the .vsix.
vsce package
code --install-extension find-type-constructions-0.0.1.vsix \
     --force
```

**You must then reload the VSCode window** for the new version to take effect: open the Command Palette (Cmd+Shift+P) and run **Developer: Reload Window**. Without this step VSCode keeps the previously loaded extension code in memory and your changes will appear to have no effect.

## Known limitations

- Walks one `ts.Program` rooted at the nearest `tsconfig.json` above the active file (following `references` to the sub-project that owns the file). Files outside that program — even in sibling tsconfigs unreachable via `references` — are not searched.
- Does not separately flag spread expressions inside a literal.
- Treats only syntactic constructions: `{ ... }`, `new X(...)`, and `<X .../>`. Factory-function calls that return a value of the type (e.g. `Promise.resolve(...)`, `Array.from(...)`, custom builders) are not surfaced.
- String- or number-union type aliases (`type X = "a" | "b"`) report no constructions, because string and number literals are not syntactic constructions of the alias.
