/**
 * Writes src/lib/unitdirectives.ts from systemd's own table of unit-file
 * settings, src/core/load-fragment-gperf.gperf.in, so the analyzer knows
 * exactly the directives systemd knows — no more, no fewer.
 *
 *   curl -sSLO https://raw.githubusercontent.com/systemd/systemd/v259/src/core/load-fragment-gperf.gperf.in
 *   npx esbuild scripts/unit-directives.ts --bundle --platform=node --format=esm \
 *     --outfile=node_modules/.cache/unit-directives.mjs
 *   node node_modules/.cache/unit-directives.mjs load-fragment-gperf.gperf.in v259
 *
 * Features behind `{% if HAVE_… %}` are taken as built in, as every major
 * distribution builds them. The table itself is not copied: only the names
 * and a one-letter kind for each, derived from the parser systemd uses.
 */

import { readFileSync, writeFileSync } from "node:fs";

const [source, version = "v259"] = process.argv.slice(2);
if (!source) throw new Error("Usage: unit-directives <load-fragment-gperf.gperf.in> [version]");
const text = readFileSync(source, "utf8");

/** Parser → kind letter. Anything unlisted is "?", known but not checked. */
const KINDS: Record<string, string> = {
  config_parse_bool: "b",
  config_parse_tristate: "b",
  config_parse_job_mode_isolate: "b",
  config_parse_sec: "t",
  config_parse_sec_fix_0: "t",
  config_parse_sec_def_infinity: "t",
  config_parse_service_timeout: "t",
  config_parse_service_timeout_abort: "t",
  config_parse_job_timeout_sec: "t",
  config_parse_job_running_timeout_sec: "t",
  config_parse_nsec: "T",
  config_parse_unsigned: "n",
  config_parse_int: "i",
  config_parse_long: "i",
  config_parse_exec: "x",
  config_parse_unit_deps: "u",
  config_parse_service_sockets: "u",
  config_parse_obsolete_unit_deps: "o",
  config_parse_trigger_unit: "U",
  config_parse_unit_slice: "U",
  config_parse_environ: "e",
  config_parse_unit_env_file: "f",
  config_parse_pid_file: "P",
  config_parse_path_spec: "p",
  config_parse_unit_mounts_for: "a",
  config_parse_working_directory: "w",
  config_parse_unit_string_printf: "s",
  config_parse_bus_name: "s",
  config_parse_timer: "c",
  config_parse_mode: "m",
  config_parse_memory_limit: "z",
  config_parse_iec_size: "Z",
  config_parse_rlimit: "l",
  config_parse_signal: "g",
  config_parse_user_group_compat: "k",
  config_parse_user_group_strv_compat: "K",
  config_parse_documentation: "d",
  config_parse_exec_directories: "D",
  config_parse_namespace_path_strv: "R",
  config_parse_tasks_max: "X",
  config_parse_cg_weight: "W",
  config_parse_cg_cpu_weight: "W",
  config_parse_capability_set: "C",
  config_parse_private_users: "E",
  config_parse_private_pids: "E",
  config_parse_private_bpf: "E",
  config_parse_protect_control_groups: "E",
  config_parse_protect_hostname: "E",
  config_parse_unit_condition_path: "q",
  config_parse_unit_condition_string: "Q",
  config_parse_cpu_quota: "%",
  config_parse_exec_nice: "N",
  config_parse_exec_output: "O",
  config_parse_exec_input: "I",
  // Settings that take one of a fixed set of words: the analyzer knows the sets.
  config_parse_service_type: "E",
  config_parse_service_restart: "E",
  config_parse_service_restart_mode: "E",
  config_parse_service_exit_type: "E",
  config_parse_service_timeout_failure_mode: "E",
  config_parse_kill_mode: "E",
  config_parse_notify_access: "E",
  config_parse_collect_mode: "E",
  config_parse_oom_policy: "E",
  config_parse_emergency_action: "E",
  config_parse_job_mode: "E",
  config_parse_protect_system: "E",
  config_parse_protect_home: "E",
  config_parse_private_tmp: "E",
  config_parse_exec_preserve_mode: "E",
  config_parse_device_policy: "E",
  config_parse_exec_keyring_mode: "E",
  config_parse_protect_proc: "E",
  config_parse_proc_subset: "E",
  config_parse_log_level: "E",
  config_parse_log_facility: "E",
  config_parse_exec_io_class: "E",
  config_parse_exec_cpu_sched_policy: "E",
  config_parse_exec_utmp_mode: "E",
  config_parse_exec_mount_propagation_flag: "E",
};

type Entry = { name: string; kind: string };

/** Drops the `{% else %}` half of every feature switch, keeping what a full build compiles. */
function enabledOnly(block: string): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of block.split("\n")) {
    const directive = /^\{%-?\s*(if|else|endif)\b/.exec(line.trim());
    if (directive) {
      skipping = directive[1] === "else";
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out;
}

function entriesOf(lines: readonly string[], prefix: RegExp): Map<string, Entry[]> {
  const bySection = new Map<string, Entry[]>();
  for (const line of lines) {
    const match = prefix.exec(line);
    if (!match) continue;
    const [, section, name, parser, ltype] = match as unknown as [string, string, string, string, string];
    const kind =
      parser === "config_parse_warn_compat"
        ? ltype.includes("DISABLED_LEGACY") ? "r" : null
        : parser === "config_parse_unit_path_printf"
          ? ltype.trim() === "true" ? "F" : "p"
          : (KINDS[parser] ?? "?");
    if (kind === null) continue;
    const list = bySection.get(section) ?? [];
    // A later line for the same name (a feature switch's other half) never wins.
    if (!list.some((entry) => entry.name === name)) list.push({ name, kind });
    bySection.set(section, list);
  }
  return bySection;
}

const macros = new Map<string, Entry[]>();
for (const match of text.matchAll(/\{%-?\s*macro (\w+)\(type\)\s*-?%\}([\s\S]*?)\{%-?\s*endmacro\s*-?%\}/g)) {
  const lines = enabledOnly(match[2]!);
  const found = entriesOf(lines, /^\{\{type\}\}()\.(\w+),\s*(\w+|NULL),\s*([^,]*),/);
  macros.set(match[1]!, found.get("") ?? []);
}

const body = enabledOnly(text.slice(text.indexOf("%%")));
const own = entriesOf(body, /^(\w+)\.(\w+),\s*(\w+|NULL),\s*([^,]*),/);
for (const entry of own.get("Install") ?? []) entry.kind = entry.name === "DefaultInstance" ? "s" : "u";

const uses = new Map<string, string[]>();
for (const match of body.join("\n").matchAll(/\{\{\s*(\w+)_CONTEXT_CONFIG_ITEMS\('(\w+)'\)\s*\}\}/g)) {
  const list = uses.get(match[2]!) ?? [];
  list.push(match[1]!.toLowerCase());
  uses.set(match[2]!, list);
}

const encode = (entries: readonly Entry[]) => entries.map((entry) => `${entry.name}:${entry.kind}`).join(" ");
const wrap = (line: string) => line.replace(/(.{1,96})(?: |$)/g, "$1\n").trimEnd().split("\n").map((part) => `    "${part} "`).join(" +\n");

const sections = [...own.keys()];
let out = `/**
 * Every setting systemd ${version} reads from a unit file, by section, with a
 * one-letter kind saying how its value is read. Generated from systemd's own
 * src/core/load-fragment-gperf.gperf.in by scripts/unit-directives.ts — do not
 * edit by hand; regenerate for a new systemd.
 *
 * Kinds: b boolean, t time span (T in nanoseconds), n unsigned, i integer,
 * x command line, u unit names, U one unit, o obsolete dependency, r removed,
 * e environment, f environment file, p absolute path (F: refusing the unit
 * when it is not), a absolute paths, P PID file, w working directory,
 * s string with specifiers, c timer trigger, m file mode, z memory size,
 * Z size, l resource limit, g signal, k user or group, K users or groups,
 * d URLs, q path condition, Q condition, % percentage, N nice level,
 * O output, I input, E a fixed set of words, D directory names, R absolute
 * paths with - and + prefixes, X task limit, W cgroup weight, C capability
 * names, ? anything else.
 */

export const SYSTEMD_VERSION = "${version.replace(/^v/, "")}";

/** Directives of each section, as "Name:kind" separated by spaces. */
export const SECTION_DIRECTIVES: Readonly<Record<string, string>> = {
`;
for (const section of sections) out += `  ${section}:\n${wrap(encode(own.get(section)!))},\n`;
out += "};\n\n/** The shared sets several sections take in: exec, kill and cgroup settings. */\nexport const SHARED_DIRECTIVES: Readonly<Record<string, string>> = {\n";
for (const [name, entries] of macros) {
  const key = name.replace(/_CONTEXT_CONFIG_ITEMS$/, "").toLowerCase();
  out += `  ${key}:\n${wrap(encode(entries))},\n`;
}
out += "};\n\n/** Which shared sets each section takes in. */\nexport const SECTION_SHARES: Readonly<Record<string, readonly string[]>> = {\n";
for (const [section, list] of uses) out += `  ${section}: [${list.map((s) => `"${s}"`).join(", ")}],\n`;
out += "};\n";

// Run from the repository root, as the command above does.
writeFileSync("src/lib/unitdirectives.ts", out);
const count = sections.reduce((sum, s) => sum + own.get(s)!.length, 0) + [...macros.values()].reduce((sum, e) => sum + e.length, 0);
console.log(`wrote ${count} names in ${sections.length} sections and ${macros.size} shared sets`);
