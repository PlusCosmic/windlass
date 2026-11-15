import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import type { GateRef } from "../graph.js";
import type { FailOutcome, Outcome } from "./types.js";

/**
 * One change to a policy file, as the flowchart editor makes them. Applying an
 * edit rewrites only the part of the YAML it touches, so the comments and
 * layout of the rest of the file survive.
 */
export type PolicyEdit =
  | { type: "add_gate"; category: string | null; gate: string; args?: unknown; index?: number }
  | { type: "remove_gate"; at: GateRef }
  | { type: "move_gate"; at: GateRef; to: GateRef }
  | { type: "set_gate_args"; at: GateRef; args: unknown }
  | { type: "set_on_fail"; at: GateRef; onFail: FailOutcome | null }
  | { type: "add_category"; name: string }
  | { type: "rename_category"; from: string; to: string }
  | { type: "remove_category"; name: string }
  | { type: "set_outcome"; category: string; outcome: Outcome }
  | { type: "set_fallback"; outcome: FailOutcome };

const CATEGORY_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Applies an edit to a policy's YAML source and returns the new source.
 *
 * Throws when the edit can't be made (the file isn't YAML, the gate isn't
 * there, the category name is taken). The result is not validated here: run it
 * through `parsePolicy`, which is what decides whether a policy is valid.
 */
export function applyEdit(source: string, edit: PolicyEdit): string {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new Error(`the policy is not valid YAML: ${doc.errors[0]!.message}`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error("the policy must be a YAML mapping");

  switch (edit.type) {
    case "add_gate": {
      const list = gateList(doc, edit.category, true);
      const entry = edit.args === undefined ? { gate: edit.gate } : { gate: edit.gate, with: edit.args };
      const index = edit.index ?? list.items.length;
      insert(list, index, doc.createNode(entry));
      break;
    }
    case "remove_gate": {
      const list = gateList(doc, edit.at.category, false);
      requireIndex(list, edit.at);
      list.items.splice(edit.at.index, 1);
      break;
    }
    case "move_gate": {
      const from = gateList(doc, edit.at.category, false);
      requireIndex(from, edit.at);
      const to = gateList(doc, edit.to.category, true);
      const [item] = from.items.splice(edit.at.index, 1);
      insert(to, edit.to.index, item);
      break;
    }
    case "set_gate_args":
      setGateKey(doc, edit.at, "with", edit.args);
      break;
    case "set_on_fail":
      setGateKey(doc, edit.at, "on_fail", edit.onFail ?? undefined);
      break;
    case "add_category": {
      requireCategoryName(edit.name);
      if (doc.hasIn(["categories", edit.name])) throw new Error(`category \`${edit.name}\` already exists`);
      // Escalate until someone gives it gates and decides it can merge.
      doc.setIn(["categories", edit.name], doc.createNode({ gates: [], outcome: "escalate" }));
      break;
    }
    case "rename_category": {
      requireCategoryName(edit.to);
      const categories = doc.getIn(["categories"]);
      if (!isMap(categories)) throw new Error("the policy has no categories");
      if (edit.from === edit.to) break;
      if (categories.has(edit.to)) throw new Error(`category \`${edit.to}\` already exists`);
      // Rename the key in place so the category keeps its position and comments.
      const pair = categories.items.find((item) => isScalar(item.key) && item.key.value === edit.from);
      if (!pair || !isScalar(pair.key)) throw new Error(`category \`${edit.from}\` is not in the policy`);
      pair.key.value = edit.to;
      break;
    }
    case "remove_category":
      if (!doc.deleteIn(["categories", edit.name])) throw new Error(`category \`${edit.name}\` is not in the policy`);
      break;
    case "set_outcome":
      if (!doc.hasIn(["categories", edit.category])) {
        throw new Error(`category \`${edit.category}\` is not in the policy`);
      }
      doc.setIn(["categories", edit.category, "outcome"], edit.outcome);
      break;
    case "set_fallback":
      doc.setIn(["fallback"], edit.outcome);
      break;
  }

  // Flow lists stay as they were written (`[a, b]`, not `[ a, b ]`).
  return doc.toString({ lineWidth: 120, flowCollectionPadding: false });
}

function gateListPath(category: string | null): string[] {
  return category === null ? ["defaults", "always"] : ["categories", category, "gates"];
}

function gateList(doc: Document, category: string | null, create: boolean): YAMLSeq {
  if (category !== null && !doc.hasIn(["categories", category])) {
    throw new Error(`category \`${category}\` is not in the policy`);
  }
  const path = gateListPath(category);
  const existing = doc.getIn(path);
  if (isSeq(existing)) return existing;
  if (existing !== undefined && existing !== null) throw new Error(`\`${path.join(".")}\` is not a list`);
  if (!create) throw new Error(`\`${path.join(".")}\` has no gates`);
  const list = doc.createNode([]) as YAMLSeq;
  doc.setIn(path, list);
  return list;
}

function insert(list: YAMLSeq, index: number, item: unknown): void {
  // An empty list is written `[]`; its first gate goes on a line of its own, like the rest of the file.
  if (list.items.length === 0) list.flow = false;
  list.items.splice(clamp(index, 0, list.items.length), 0, item);
}

function requireIndex(list: YAMLSeq, ref: GateRef): void {
  if (!Number.isInteger(ref.index) || ref.index < 0 || ref.index >= list.items.length) {
    throw new Error(`no gate at ${gateListPath(ref.category).join(".")}[${ref.index}]`);
  }
}

/**
 * Sets `with` or `on_fail` on a gate, whichever of its three forms it's written in:
 *
 *   - no_new_skips                  becomes the explicit form
 *   - paths_only: [...]             its arguments are the shorthand's value
 *   - gate: ci_green / with: {...}  the explicit form
 *
 * `undefined` removes the key.
 */
function setGateKey(doc: Document, ref: GateRef, key: "with" | "on_fail", value: unknown): void {
  const list = gateList(doc, ref.category, false);
  requireIndex(list, ref);
  const item = list.items[ref.index];

  if (isScalar(item)) {
    if (value === undefined) return;
    list.items[ref.index] = doc.createNode({ gate: item.value, [key]: value });
    return;
  }
  if (!isMap(item)) throw new Error(`the gate at ${gateListPath(ref.category).join(".")}[${ref.index}] is malformed`);

  const map = item as YAMLMap;
  if (key === "with" && !map.has("gate")) {
    const name = map.items.map((pair) => (isScalar(pair.key) ? pair.key.value : null)).find((k) => k !== "on_fail");
    if (typeof name !== "string") throw new Error("the gate entry names no gate");
    // The shorthand has nowhere to put "no arguments" but null, which the parser reads as none.
    map.set(name, value === undefined ? null : doc.createNode(value));
    return;
  }
  if (value === undefined) map.delete(key);
  else map.set(key, doc.createNode(value));
}

function requireCategoryName(name: string): void {
  if (!CATEGORY_NAME.test(name)) throw new Error("a category name must be snake_case, starting with a letter");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A gate as the file has it, before validation: the editor shows these values
 * so that arguments the parser rejects can still be seen and corrected.
 */
export function readGate(source: string, ref: GateRef): { gate: string; args: unknown; onFail: unknown } | null {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return null;
  const list = doc.getIn(gateListPath(ref.category));
  if (!isSeq(list)) return null;
  const item = list.items[ref.index];
  if (isScalar(item))
    return typeof item.value === "string" ? { gate: item.value, args: undefined, onFail: undefined } : null;
  if (!isMap(item)) return null;

  const entry = item.toJSON() as Record<string, unknown>;
  if (typeof entry.gate === "string") return { gate: entry.gate, args: entry.with, onFail: entry.on_fail };
  const name = Object.keys(entry).find((key) => key !== "on_fail");
  if (name === undefined) return null;
  return { gate: name, args: entry[name] ?? undefined, onFail: entry.on_fail };
}
