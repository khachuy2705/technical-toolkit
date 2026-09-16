import { fail, indentValue, ok, sortKeysDeep, type FormatResult, type Indent } from "./format";

export type YamlMode = "format" | "to-json" | "from-json";

export const YAML_MODES: readonly { id: YamlMode; label: string; hint: string }[] = [
  { id: "format", label: "Tidy YAML", hint: "reindent and normalise, output stays YAML" },
  { id: "to-json", label: "YAML → JSON", hint: "parse YAML, emit JSON" },
  { id: "from-json", label: "JSON → YAML", hint: "parse JSON, emit YAML" },
] as const;

export interface YamlOptions {
  mode: YamlMode;
  indent: Indent;
  sortKeys: boolean;
}

export const DEFAULT_YAML_OPTIONS: YamlOptions = {
  mode: "format",
  indent: 2,
  sortKeys: false,
};

/**
 * js-yaml is loaded on demand.
 *
 * It is the one runtime dependency this site ships, and only the YAML page ever
 * downloads it. Hand-rolling a YAML parser was the alternative, and a formatter
 * that silently misreads a document is worse than no formatter at all.
 */
type YamlLib = typeof import("js-yaml");

let cached: Promise<YamlLib> | undefined;

function loadYaml(): Promise<YamlLib> {
  cached ??= import("js-yaml");
  return cached;
}

/** YAML indentation must be a number of spaces; tabs are illegal in YAML. */
function yamlIndent(indent: Indent): number {
  return indent === "tab" ? 4 : indent;
}

function explain(error: unknown): string {
  if (error && typeof error === "object" && "mark" in error) {
    const { mark, reason } = error as { mark?: { line: number; column: number }; reason?: string };
    if (mark) {
      // js-yaml marks are 0-based; editors and humans count from 1.
      return `${reason ?? "Invalid YAML"} — line ${mark.line + 1}, column ${mark.column + 1}.`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function convertYaml(input: string, options: YamlOptions): Promise<FormatResult> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return ok("");

  const yaml = await loadYaml();

  let parsed: unknown;
  try {
    if (options.mode === "from-json") {
      parsed = JSON.parse(trimmed);
    } else {
      // loadAll, not load: a YAML stream may hold several documents separated
      // by `---`, and `load` throws rather than picking one.
      const documents = yaml.loadAll(trimmed);
      if (documents.length === 0) return ok("");
      parsed = documents.length === 1 ? documents[0] : documents;
      if (documents.length > 1 && options.mode === "format") {
        return ok(
          documents
            .map((document) => dump(yaml, document, options))
            .join("---\n"),
          `${documents.length} documents`,
        );
      }
    }
  } catch (error) {
    if (options.mode === "from-json") {
      return fail(error instanceof Error ? error.message : String(error));
    }
    return fail(explain(error));
  }

  const value = options.sortKeys ? sortKeysDeep(parsed) : parsed;

  if (options.mode === "to-json") {
    const output = JSON.stringify(value, null, indentValue(options.indent));
    return output === undefined ? ok("") : ok(output);
  }

  try {
    return ok(dump(yaml, value, options));
  } catch (error) {
    return fail(explain(error));
  }
}

function dump(yaml: YamlLib, value: unknown, options: YamlOptions): string {
  return yaml.dump(value, {
    indent: yamlIndent(options.indent),
    sortKeys: options.sortKeys,
    // Anchors and aliases are valid YAML, but a "tidy" output full of `&ref_0`
    // surprises anyone who did not write them. Expand instead.
    noRefs: true,
    lineWidth: 100,
  });
}
