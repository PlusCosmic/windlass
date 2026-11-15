/**
 * Questions that ship with the engine. A policy can name one by `id` and leave
 * `question` out, or write its own question under any name.
 */
export interface EvaluatorPreset {
  name: string;
  description: string;
  question: string;
}

export const evaluatorPresets: readonly EvaluatorPreset[] = [
  {
    name: "fully_flag_gated",
    description: "Everything the diff changes is unreachable while the declared feature flag is off",
    question: [
      "Is everything this diff adds or changes reachable only while the feature flag `{{flag}}` is on?",
      "Fail if any new or changed behaviour takes effect while the flag is off: an endpoint, a UI element,",
      "a background job, a schema or data change, a changed default.",
      "Tests, documentation and code that only runs after the flag is checked are fine.",
    ].join("\n"),
  },
];

export function evaluatorPreset(name: string): EvaluatorPreset | undefined {
  return evaluatorPresets.find((preset) => preset.name === name);
}
