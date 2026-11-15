import { Notice } from "@pluscosmic/ui";
import { copy } from "./copy/app";

/** What the policy file has wrong at a node. */
export function Problems({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <Notice tone="error" title={copy.inspector.errors} compact>
      <ul className="wl-plain-list">
        {errors.map((error, i) => (
          <li key={i}>{error}</li>
        ))}
      </ul>
    </Notice>
  );
}
