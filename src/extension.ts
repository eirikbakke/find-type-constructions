import * as vscode from "vscode";
import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";

const VIEW_ID = "find-type-constructions.results";

let resultsProvider: ConstructionsProvider | undefined;
let resultsTreeView: vscode.TreeView<TreeNode> | undefined;

export function activate(context: vscode.ExtensionContext) {
  resultsProvider = new ConstructionsProvider();
  resultsTreeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: resultsProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(
    resultsTreeView,
    vscode.commands.registerCommand("find-type-constructions.find", runCommand),
    vscode.commands.registerCommand(
      "find-type-constructions.openLocation",
      openLocation
    )
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

  const nearestTsconfig = findTsConfig(filePath);
  if (!nearestTsconfig) {
    vscode.window.showErrorMessage("Could not find a tsconfig.json.");
    return;
  }
  const tsconfigPath = resolveTsconfigForFile(nearestTsconfig, filePath);
  if (!tsconfigPath) {
    vscode.window.showErrorMessage(
      `Active file is not included by ${nearestTsconfig} or any of its referenced projects.`
    );
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
        resultsProvider?.setResults(result.name, result.constructions);
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        if (result.constructions.length === 0) {
          vscode.window.showInformationMessage(
            `No constructions found for '${result.name}'.`
          );
        }
      } catch (e) {
        vscode.window.showErrorMessage(
          `Find Type Constructions: ${(e as Error).message}`
        );
      }
    }
  );
}

async function openLocation(location: vscode.Location) {
  const doc = await vscode.workspace.openTextDocument(location.uri);
  await vscode.window.showTextDocument(doc, {
    selection: location.range,
    preserveFocus: false,
  });
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

function parseTsconfig(tsconfigPath: string): ts.ParsedCommandLine | undefined {
  const configFile = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
  if (configFile.error || !configFile.config) return undefined;
  return ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath)
  );
}

function resolveTsconfigForFile(
  tsconfigPath: string,
  filePath: string
): string | undefined {
  const normalizedTarget = path.normalize(filePath);
  const visited = new Set<string>();
  const walk = (cfg: string): string | undefined => {
    const resolved = path.normalize(cfg);
    if (visited.has(resolved)) return undefined;
    visited.add(resolved);
    const parsed = parseTsconfig(resolved);
    if (!parsed) return undefined;
    if (parsed.fileNames.some((f) => path.normalize(f) === normalizedTarget)) {
      return resolved;
    }
    for (const ref of parsed.projectReferences ?? []) {
      // ref.path may point to a directory or a tsconfig file.
      const refPath = ref.path.endsWith(".json")
        ? ref.path
        : path.join(ref.path, "tsconfig.json");
      const hit = walk(refPath);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(tsconfigPath);
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

interface Construction {
  location: vscode.Location;
  preview: string;
}

type FindResult =
  | { kind: "error"; message: string }
  | { kind: "ok"; name: string; constructions: Construction[] };

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
  const constructions: Construction[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const t = checker.getContextualType(node);
        if (t && typeMatches(t, targetDecls, checker)) {
          const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const end = sf.getLineAndCharacterOfPosition(node.getEnd());
          constructions.push({
            location: new vscode.Location(
              vscode.Uri.file(sf.fileName),
              new vscode.Range(
                start.line,
                start.character,
                end.line,
                end.character
              )
            ),
            preview: getLinePreview(sf, start.line),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { kind: "ok", name: token.text, constructions };
}

function getLinePreview(sf: ts.SourceFile, line: number): string {
  const starts = sf.getLineStarts();
  const from = starts[line];
  const to = line + 1 < starts.length ? starts[line + 1] : sf.text.length;
  return sf.text.slice(from, to).replace(/\s+$/, "").trim();
}

function typeMatches(
  type: ts.Type,
  targetDecls: Set<ts.Declaration>,
  checker: ts.TypeChecker
): boolean {
  const queue: ts.Type[] = [type];
  const seen = new Set<ts.Type>();
  while (queue.length > 0) {
    const t = queue.shift();
    if (t === undefined || seen.has(t)) continue;
    seen.add(t);
    // t.symbol is typed non-nullable but is undefined at runtime for
    // anonymous types / intrinsics, hence the eslint-disable.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const decls = (t.aliasSymbol ?? t.symbol)?.declarations;
    if (decls?.some((d) => targetDecls.has(d))) return true;
    // Unions / intersections: check each constituent.
    if (t.isUnionOrIntersection()) {
      for (const part of t.types) queue.push(part);
    }
    // Interface/class extends-chains: walk base types so a literal typed
    // against a subtype of the cursor interface still matches.
    if (t.isClassOrInterface()) {
      for (const base of checker.getBaseTypes(t)) queue.push(base);
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

interface FileNode {
  kind: "file";
  uri: vscode.Uri;
  constructions: Construction[];
}

interface ConstructionNode {
  kind: "construction";
  construction: Construction;
}

type TreeNode = FileNode | ConstructionNode;

class ConstructionsProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private fileNodes: FileNode[] = [];

  setResults(typeName: string, constructions: Construction[]) {
    const byFile = new Map<string, FileNode>();
    for (const c of constructions) {
      const key = c.location.uri.toString();
      let node = byFile.get(key);
      if (!node) {
        node = { kind: "file", uri: c.location.uri, constructions: [] };
        byFile.set(key, node);
      }
      node.constructions.push(c);
    }
    this.fileNodes = [...byFile.values()].sort((a, b) =>
      a.uri.fsPath.localeCompare(b.uri.fsPath)
    );
    if (resultsTreeView) {
      const total = constructions.length;
      resultsTreeView.message =
        total === 0
          ? `No constructions found for '${typeName}'.`
          : `${total.toString()} construction${total === 1 ? "" : "s"} of '${typeName}' in ${this.fileNodes.length.toString()} file${this.fileNodes.length === 1 ? "" : "s"}.`;
    }
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "file") {
      const item = new vscode.TreeItem(
        path.basename(node.uri.fsPath),
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.resourceUri = node.uri;
      item.description = vscode.workspace.asRelativePath(node.uri, false);
      item.iconPath = vscode.ThemeIcon.File;
      item.tooltip = node.uri.fsPath;
      return item;
    }
    const c = node.construction;
    const line = c.location.range.start.line + 1;
    const col = c.location.range.start.character + 1;
    const item = new vscode.TreeItem(c.preview);
    item.description = `${line.toString()}:${col.toString()}`;
    item.tooltip = `${c.location.uri.fsPath}:${line.toString()}:${col.toString()}`;
    item.command = {
      command: "find-type-constructions.openLocation",
      title: "Open",
      arguments: [c.location],
    };
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.fileNodes;
    if (node.kind === "file") {
      return node.constructions.map(
        (c): ConstructionNode => ({ kind: "construction", construction: c })
      );
    }
    return [];
  }
}
