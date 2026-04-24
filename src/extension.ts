import * as vscode from "vscode";
import * as path from "path";
import {
  ConstructionLocation,
  findConstructions,
  findTsConfig,
  resolveTsconfigForFile,
} from "./core";

const VIEW_ID = "find-type-constructions.results";

interface Construction {
  location: vscode.Location;
  preview: string;
}

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
        resultsProvider?.setResults(
          result.name,
          result.constructions.map(toVscode)
        );
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

function toVscode(c: ConstructionLocation): Construction {
  return {
    location: new vscode.Location(
      vscode.Uri.file(c.file),
      new vscode.Range(c.startLine, c.startCharacter, c.endLine, c.endCharacter)
    ),
    preview: c.preview,
  };
}

async function openLocation(location: vscode.Location) {
  const doc = await vscode.workspace.openTextDocument(location.uri);
  await vscode.window.showTextDocument(doc, {
    selection: location.range,
    preserveFocus: false,
  });
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
