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

// Compare two file paths the way the host filesystem would. On
// case-insensitive filesystems (macOS APFS / HFS+ default, Windows NTFS
// default), `/Users/foo/X.ts` and `/users/foo/x.ts` refer to the same file
// and must compare equal — VSCode is free to hand us either casing.
export function pathsEqual(
  a: string,
  b: string,
  caseSensitive: boolean
): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return caseSensitive ? na === nb : na.toLowerCase() === nb.toLowerCase();
}

export function resolveTsconfigForFile(
  tsconfigPath: string,
  filePath: string,
  caseSensitive: boolean = ts.sys.useCaseSensitiveFileNames
): string | undefined {
  const visited = new Set<string>();
  const walk = (cfg: string): string | undefined => {
    const resolved = path.normalize(cfg);
    const key = caseSensitive ? resolved : resolved.toLowerCase();
    if (visited.has(key)) return undefined;
    visited.add(key);
    const parsed = parseTsconfig(resolved);
    if (!parsed) return undefined;
    if (parsed.fileNames.some((f) => pathsEqual(f, filePath, caseSensitive))) {
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
  offset: number,
  caseSensitive: boolean = ts.sys.useCaseSensitiveFileNames
): FindResult {
  const program = createProgram(tsconfigPath);
  const checker = program.getTypeChecker();

  const sourceFile = program
    .getSourceFiles()
    .find((sf) => pathsEqual(sf.fileName, filePath, caseSensitive));
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
    (d) =>
      ts.isInterfaceDeclaration(d) ||
      ts.isTypeAliasDeclaration(d) ||
      ts.isClassDeclaration(d)
  );
  if (!isTypeSymbol) {
    const kinds = symbol.declarations
      .map((d) => ts.SyntaxKind[d.kind])
      .join(", ");
    return {
      kind: "error",
      message: `Symbol '${token.text}' is not an interface, type alias, or class (declarations: ${kinds}).`,
    };
  }

  const targetDecls = new Set<ts.Declaration>(symbol.declarations);
  const constructions: ConstructionLocation[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const record = (node: ts.Node) => {
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
    };
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const t = checker.getContextualType(node);
        if (t && typeMatches(t, targetDecls, checker)) record(node);
      } else if (ts.isNewExpression(node)) {
        // The instance type of `new X(...)` — matches when X (or a subtype)
        // is the cursor symbol. Covers constructor-var globals like
        // ResizeObserver/Map/Set as well as plain classes.
        const t = checker.getTypeAtLocation(node);
        if (typeMatches(t, targetDecls, checker)) record(node);
      } else if (
        ts.isJsxOpeningElement(node) ||
        ts.isJsxSelfClosingElement(node)
      ) {
        // A `<Component ... />` site constructs a value of the
        // component's props interface — usually the most common
        // construction site for a React Props type, and one that has no
        // ObjectLiteralExpression to match. The contextual type at the
        // attributes node is typically `IntrinsicAttributes & Props`;
        // typeMatches walks the intersection so the Props constituent
        // matches.
        const t = checker.getContextualType(node.attributes);
        if (t && typeMatches(t, targetDecls, checker)) record(node);
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
