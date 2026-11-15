import { Field, Notice, Textarea } from "@pluscosmic/ui";
import type { SimulationResponse } from "./api";
import { copy } from "./copy/app";

export function YamlPane({
  source,
  errors,
  onChange,
}: {
  source: string;
  errors: SimulationResponse["policy"]["errors"];
  onChange: (source: string) => void;
}) {
  return (
    <div className="wl-inspector wl-yaml">
      {errors.length > 0 ? (
        <Notice tone="error" title={copy.yaml.errors} compact>
          <ul className="wl-plain-list">
            {errors.map((error, i) => (
              <li key={i}>
                <span className="wl-code">{error.path || copy.yaml.wholeFile}</span>: {error.message}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <Field label={copy.yaml.label} hint={copy.yaml.hint}>
        <Textarea
          className="wl-code wl-yaml-text"
          value={source}
          spellCheck={false}
          aria-invalid={errors.length > 0}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    </div>
  );
}
