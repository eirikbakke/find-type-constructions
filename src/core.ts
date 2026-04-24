import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";

export interface ConstructionLocation {
  file: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  preview: string;
}

export type FindResult =
  | { kind: "error"; message: string }
  | { kind: "ok"; name: string; constructions: ConstructionLocation[] };

export function findTsConfig(fromPath: string): string | undefined {
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

export function resolveTsconfigForFile(
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

export function findConstructions(
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
  const constructions: ConstructionLocation[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const t = checker.getContextualType(node);
        if (t && typeMatches(t, targetDecls, checker)) {
          const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const end = sf.getLineAndCharacterOfPosition(node.getEnd());
          constructions.push({
            file: sf.fileName,
            startLine: start.line,
            startCharacter: start.character,
            endLine: end.line,
            endCharacter: end.character,
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
