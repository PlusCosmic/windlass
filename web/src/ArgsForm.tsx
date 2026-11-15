import { Field, Textarea } from "@pluscosmic/ui";
import { useEffect, useState } from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { copy } from "./copy/app";

/** The parts of JSON Schema the gates' arguments use. */
interface Schema {
  type?: string;
  items?: Schema;
  properties?: Record<string, Schema>;
}

const isStringList = (schema: Schema) => schema.type === "array" && schema.items?.type === "string";

function toLines(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** The entries typed into a one-per-line field: trimmed, without the blank lines. */
function parse(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A list of strings as a textarea, one per line. Keeps what is typed, blank lines and all, until the value changes from outside. */
function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (next: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  // `value` is a fresh array each render, so the effect follows its content.
  const joined = value.join("\n");
  useEffect(() => {
    setText((current) => (parse(current).join("\n") === joined ? current : joined));
  }, [joined]);

  return (
    <Field label={label} hint={copy.inspector.listHint}>
      <Textarea
        className="wl-code"
        value={text}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          const next = parse(event.target.value);
          if (!sameLines(next, value)) onChange(next);
        }}
      />
    </Field>
  );
}

/** Arguments whose shape this form doesn't know, edited as YAML. */
function RawField({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const render = (v: unknown) => (v === undefined ? "" : stringifyYaml(v).trimEnd());
  const [text, setText] = useState(render(value));
  const [invalid, setInvalid] = useState(false);
  const rendered = render(value);
  useEffect(() => {
    setText(rendered);
    setInvalid(false);
  }, [rendered]);

  return (
    <Field
      label={copy.inspector.arguments}
      hint={copy.inspector.rawHint}
      error={invalid ? copy.inspector.rawInvalid : null}
    >
      <Textarea
        className="wl-code"
        value={text}
        rows={4}
        spellCheck={false}
        aria-invalid={invalid}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          try {
            onChange(text.trim() === "" ? undefined : parseYaml(text));
          } catch {
            setInvalid(true);
          }
        }}
      />
    </Field>
  );
}

/**
 * A form for a gate's arguments, drawn from the gate's JSON Schema: a list of
 * strings, or an object whose properties are lists of strings. Anything else
 * falls back to YAML. Empty arguments are removed, not written as empty lists.
 */
export function ArgsForm({
  schema,
  value,
  onChange,
}: {
  schema: unknown;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const shape = (schema ?? {}) as Schema;

  if (isStringList(shape)) {
    return (
      <ListField
        label={copy.inspector.arguments}
        value={toLines(value)}
        onChange={(next) => onChange(next.length > 0 ? next : undefined)}
      />
    );
  }

  const properties = Object.entries(shape.properties ?? {});
  if (shape.type === "object" && properties.length > 0 && properties.every(([, property]) => isStringList(property))) {
    const current =
      typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return (
      <>
        {properties.map(([name]) => (
          <ListField
            key={name}
            label={name}
            value={toLines(current[name])}
            onChange={(next) => {
              const merged: Record<string, unknown> = { ...current, [name]: next };
              if (next.length === 0) delete merged[name];
              onChange(Object.keys(merged).length > 0 ? merged : undefined);
            }}
          />
        ))}
      </>
    );
  }

  return <RawField value={value} onChange={onChange} />;
}
