# Find Type Constructions

A VSCode extension that finds every place where an object literal is constructed satisfying the TypeScript interface (or type alias) under the cursor.

## Motivation

TypeScript's type system is structural: an object becomes a value of interface type simply by having the right shape at an assignment site. There is no syntactic `new Foo(...)` marker, so neither tsserver nor VSCode can enumerate the places where an interface is constructed.

In practice this means that when you want to add a field to an interface and update every construction site, the standard VSCode commands don't help:

- **Find All References** (Shift+F12) returns every mention of the name — imports, parameter annotations, return types, etc. — not just constructions.
- **Go to Implementations** (Cmd+F12) reports "No implementations found" for interfaces, because implementations are only tracked for classes.

The information does exist inside the TypeScript compiler: at every object literal, the checker computes a contextual type and verifies assignability. It is simply not surfaced through tsserver.

This extension exposes it.

## What it does

Adds a command, **Find Type Constructions**, that operates on the interface or type alias under the cursor. It loads a `ts.Program` from the nearest `tsconfig.json`, walks every `ObjectLiteralExpression` in the program, asks the checker for the literal's contextual type, and reports all literals whose contextual type resolves back to the cursor symbol. Results appear in VSCode's References panel.

Union and intersection constituents are checked as well, so a literal typed against `Foo | null` is still reported as a construction of `Foo`.

## Usage

1. Put your cursor on the name of an interface or type alias.
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

## Known limitations

- Works off the nearest `tsconfig.json` above the active file; does not compose multiple projects.
- Reports direct type identity only. A literal typed against a subtype of the cursor interface will not be reported.
- Does not separately flag spread expressions inside a literal.
