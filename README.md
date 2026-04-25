# Find Type Constructions

A VSCode extension that finds every place where a value of the TypeScript interface, type alias, or class under the cursor is constructed — both object literals (`{ ... }`) typed against the symbol and `new X(...)` expressions whose result is a value of that type.

> **Note:** This plugin was written entirely by [Claude Code](https://claude.com/claude-code) under the guidance of Eirik Bakke.

## Motivation

TypeScript's type system is structural: an object becomes a value of interface type simply by having the right shape at an assignment site, with no syntactic construction marker. And while `new Foo(...)` _is_ a syntactic marker, neither tsserver nor VSCode lets you enumerate every `new` site for a given type. So whether the type is constructed via object literals, `new` expressions, or both, the standard navigation falls short.

In practice this means that when you want to add a field to an interface and update every construction site, the standard VSCode commands don't help:

- **Find All References** (Shift+F12) returns every mention of the name — imports, parameter annotations, return-type annotations, etc. — and typically misses the actual construction sites entirely. When a function declares its return type as an interface and returns an object literal, the interface name appears only at the function's signature, never at the `return` statement that produces the literal, so Find All References does not surface the construction at all.
- **Go to Implementations** (Cmd+F12) reports "No implementations found" for interfaces, because implementations are only tracked for classes.

The information does exist inside the TypeScript compiler: at every object literal the checker computes a contextual type, and at every `new` expression it computes the constructed instance type. It is simply not surfaced through tsserver.

This extension exposes it.

## What it does

Adds a command, **Find Type Constructions**, that operates on the interface, type alias, or class under the cursor. It loads a `ts.Program` from the nearest `tsconfig.json` and walks every source file, reporting two kinds of construction sites:

- Every `ObjectLiteralExpression` whose contextual type resolves back to the cursor symbol.
- Every `NewExpression` whose constructed instance type resolves back to the cursor symbol — covering plain class constructions as well as constructor-var globals like `ResizeObserver`, `Map`, and `Set`, where the lib declares an interface merged with a `var` whose value is a constructor.

Results appear in a dedicated panel view.

Union and intersection constituents and `extends` chains are walked as well, so a literal typed against `Foo | null` or against a subtype of `Foo` is still reported as a construction of `Foo`.

## Usage

1. Put your cursor on the name of an interface, type alias, or class.
2. Run **Find Type Constructions** from the command palette (Cmd+Shift+P) or the editor context menu.
3. Browse hits in the References panel.

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

- Works off the nearest `tsconfig.json` above the active file; does not compose multiple projects.
- Does not separately flag spread expressions inside a literal.
