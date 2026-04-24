import * as vscode from "vscode";
import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("find-type-constructions.find", runCommand)
  );
}

async function runCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor.");
    return;
  }
  const doc = editor.document;
  if (doc.languageId !== "typescript" && doc.languageId !== "typescriptreact") {
    vscode.window.showErrorMessage("Not a TypeScript file.");
    return;
  }

  const filePath = doc.uri.fsPath;
  const offset = doc.offsetAt(editor.selection.active);

  const tsconfigPath = findTsConfig(filePath);
  if (!tsconfigPath) {
    vscode.window.showErrorMessage("Could not find a tsconfig.json.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Finding type constructions...",
    },
    async () => {
      try {
        const result = findConstructions(tsconfigPath, filePath, offset);
        if (result.kind === "error") {
          vscode.window.showErrorMessage(
            `Find Type Constructions: ${result.message}`
          );
          return;
        }
        if (result.locations.length === 0) {
          vscode.window.showInformationMessage(
            `No constructions found for '${result.name}'.`
          );
          return;
        }
        await vscode.commands.executeCommand(
          "editor.action.showReferences",
          doc.uri,
          editor.selection.active,
          result.locations
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Find Type Constructions: ${(e as Error).message}`
        );
      }
    }
  );
}

function findTsConfig(fromPath: string): string | undefined {
  let dir = path.dirname(fromPath);
  let parent = path.dirname(dir);
  while (parent !== dir) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    dir = parent;
    parent = path.dirname(dir);
  }
  const candidate = path.join(dir, "tsconfig.json");
  return fs.existsSync(candidate) ? candidate : undefined;
}

function createProgram(tsconfigPath: string): ts.Program {
  const configFile = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath)
  );
  const programOptions: ts.CreateProgramOptions = {
    rootNames: parsed.fileNames,
    options: parsed.options,
  };
  if (parsed.projectReferences) {
    programOptions.projectReferences = parsed.projectReferences;
  }
  return ts.createProgram(programOptions);
}

type FindResult =
  | { kind: "error"; message: string }
  | { kind: "ok"; name: string; locations: vscode.Location[] };

function findConstructions(
  tsconfigPath: string,
  filePath: string,
  offset: number
): FindResult {
  const program = createProgram(tsconfigPath);
  const checker = program.getTypeChecker();

  const normalized = path.normalize(filePath);
  const sourceFile = program
    .getSourceFiles()
    .find((sf) => path.normalize(sf.fileName) === normalized);
  if (!sourceFile) {
    return {
      kind: "error",
      message: `Active file is not part of the program loaded from ${tsconfigPath}.`,
    };
  }

  const token = findTokenAtPosition(sourceFile, offset);
  if (!token) {
    return { kind: "error", message: "No token at cursor position." };
  }
  if (!ts.isIdentifier(token)) {
    return {
      kind: "error",
      message: `Cursor is on a ${ts.SyntaxKind[token.kind]}, not an identifier.`,
    };
  }

  const symbol = checker.getSymbolAtLocation(token);
  if (!symbol?.declarations?.length) {
    return {
      kind: "error",
      message: `No symbol resolved for identifier '${token.text}'.`,
    };
  }

  const isTypeSymbol = symbol.declarations.some(
    (d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)
  );
  if (!isTypeSymbol) {
    const kinds = symbol.declarations
      .map((d) => ts.SyntaxKind[d.kind])
      .join(", ");
    return {
      kind: "error",
      message: `Symbol '${token.text}' is not an interface or type alias (declarations: ${kinds}).`,
    };
  }

  const targetDecls = new Set<ts.Declaration>(symbol.declarations);
  const locations: vscode.Location[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const t = checker.getContextualType(node);
        if (t && typeMatches(t, targetDecls)) {
          const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const end = sf.getLineAndCharacterOfPosition(node.getEnd());
          locations.push(
            new vscode.Location(
              vscode.Uri.file(sf.fileName),
              new vscode.Range(
                start.line,
                start.character,
                end.line,
                end.character
              )
            )
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { kind: "ok", name: token.text, locations };
}

function typeMatches(type: ts.Type, targetDecls: Set<ts.Declaration>): boolean {
  const queue: ts.Type[] = [type];
  const seen = new Set<ts.Type>();
  while (queue.length > 0) {
    const t = queue.shift();
    if (t === undefined || seen.has(t)) continue;
    seen.add(t);
    const decls = (t.aliasSymbol ?? t.symbol).declarations;
    if (decls?.some((d) => targetDecls.has(d))) return true;
    // Unions / intersections: check each constituent.
    if (t.isUnionOrIntersection()) {
      for (const part of t.types) queue.push(part);
    }
  }
  return false;
}

function findTokenAtPosition(
  sf: ts.SourceFile,
  offset: number
): ts.Node | undefined {
  const find = (node: ts.Node): ts.Node | undefined => {
    if (offset < node.getStart(sf) || offset > node.getEnd()) return undefined;
    for (const child of node.getChildren(sf)) {
      const hit = find(child);
      if (hit) return hit;
    }
    return node;
  };
  return find(sf);
}
