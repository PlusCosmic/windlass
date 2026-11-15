/** Every word the editor shows, in one place (the `ui/no-jsx-copy` lint rule keeps them here). */
export const copy = {
  brand: "Windlass",
  loading: "Loading…",

  signIn: {
    title: "Sign in to Windlass",
    body: "The editor is only open to the people this Windlass is set up for.",
    action: "Sign in with GitHub",
  },

  failed: {
    title: "Windlass couldn't load",
    retry: "Try again",
  },

  menu: {
    signedInAs: (login: string) => `Signed in as ${login}`,
    dev: "Dev mode: no sign-in",
    signOut: "Sign out",
  },

  repo: {
    label: "Repository",
    none: {
      title: "No repositories yet",
      app: "Install the Windlass GitHub App on a repository and it will appear here.",
      dev: "Import one with `node app/dist/server.mjs import owner/name`, with GITHUB_TOKEN set.",
    },
  },

  toolbar: {
    draft: "Unsaved draft",
    saved: "Matches the default branch",
    invalid: "Draft is invalid",
    undo: "Undo",
    reset: "Discard draft",
    copy: "Copy YAML",
    copied: "Policy copied",
    propose: "Open pull request",
    proposing: "Opening…",
    proposed: "Pull request opened",
    view: "View",
    proposeDevHint: "Dev mode never writes to GitHub. Copy the YAML instead.",
  },

  pulls: {
    title: "Pull requests",
    replayed: (count: number) => `${count} replayed under this policy`,
    empty: {
      title: "Nothing to replay yet",
      body: "Windlass keeps each pull request it judges. Import recent ones to try the policy against them now.",
      action: "Import recent pull requests",
      importing: "Importing…",
      unreachable: "Windlass can't reach this repository on GitHub.",
    },
    imported: (count: number) => `Imported ${count} pull request${count === 1 ? "" : "s"}`,
    filter: { all: "All", changed: "Changed by draft", label: "Which pull requests to list" },
    noneChanged: "The draft decides every pull request the same way.",
    noCategory: "no intent",
    was: (outcome: string) => `was ${outcome}`,
    state: { open: "open", closed: "closed", merged: "merged" },
  },

  outcome: {
    merge: "Merge",
    escalate: "Escalate",
    block: "Block",
    pending: "Pending",
  },
  /** Shadow mode: a merge decision is only ever reported. */
  outcomeNoun: {
    merge: "would merge",
    escalate: "escalate",
    block: "block",
    pending: "pending",
  },

  canvas: {
    start: "Pull request",
    startHint: "opened or updated",
    builtin: {
      policy: { title: "Policy loads", hint: "from the base branch" },
      protected_paths: { title: "Policy untouched", hint: "nothing under .windlass/" },
      intent: { title: "Intent declared", hint: "a valid windlass block" },
    },
    builtinFail: "else escalate",
    gate: "Gate",
    evaluator: "Evaluator",
    router: { title: "Declared category", hint: "routes to its lane" },
    fallback: "anything else",
    fallbackTitle: "No such category",
    laneEnd: (category: string) => `${category} passes`,
    onFail: (outcome: string) => `fail → ${outcome}`,
    minConfidence: (value: number) => `confidence ≥ ${value}`,
    noArgs: "no arguments",
    addGate: "Add a gate here",
    addAlways: "Add a gate that runs on every pull request",
    addTo: (category: string) => `Add a gate to ${category}`,
    count: (count: number) => `${count} stopped`,
    failing: (count: number) => `${count} replayed pull request${count === 1 ? "" : "s"} taken off the merge path here`,
    problems: (count: number) => `${count} problem${count === 1 ? "" : "s"}`,
    undrawable: {
      title: "This policy can't be drawn",
      body: "Its YAML doesn't have the shape of a policy. Fix it in the YAML tab, or discard the draft.",
    },
    status: {
      pass: "passed",
      fail: "failed",
      error: "errored",
      pending: "waiting",
      skipped: "not run",
      low_confidence: "unsure",
      visited: "reached",
    },
  },

  panel: {
    tabs: { node: "Node", pull: "Pull request", yaml: "YAML", label: "What the side panel shows" },
  },

  inspector: {
    empty: {
      title: "Select a node",
      body: "Click a gate, the category router or an outcome to change it. Click a pull request to watch it travel the policy.",
    },
    summaryTitle: "This policy, replayed",
    summaryNone: "No pull requests to replay.",
    before: "Default branch",
    after: "Draft",
    arguments: "Arguments",
    onFail: {
      label: "When it fails",
      default: (outcome: string) => `Default (${outcome})`,
      hint: "A failed gate takes the pull request off the merge path. The rest still run, and the most severe result wins.",
    },
    moveTo: "Runs",
    always: "On every pull request",
    inCategory: (category: string) => `Only in ${category}`,
    remove: "Remove gate",
    listHint: "One per line",
    rawHint: "YAML",
    rawInvalid: "That isn't valid YAML.",
    errors: "Problems",
    offPath: "Off the merge path here",
    offPathNone: "No replayed pull request fails here.",
    builtin: {
      policy:
        "The policy is read from the pull request's base branch, never from the pull request itself. If it's missing or invalid, everything escalates.",
      protected_paths:
        "A pull request that changes anything under .windlass/ always escalates, so it can't loosen the policy that judges it.",
      intent:
        "The pull request declares a category in a fenced windlass block in its description. It's a claim to verify: a missing or malformed block escalates.",
    },
    builtinFixed: "Built into the engine. It can't be removed or changed here.",
    router: {
      body: "Sends each pull request to the lane of the category it declared.",
      fallback: "A category the policy doesn't define",
      undefinedTitle: "Declared, but not in the policy",
      undefinedBody:
        "Categories replayed pull requests declared that have no lane. Until one exists they take the fallback.",
      addLane: "Add lane",
      newCategory: "New category",
      newCategoryHint: "snake_case, as the pull requests will declare it",
      add: "Add category",
    },
    lane: {
      name: "Category",
      rename: "Rename",
      outcome: "When every gate passes",
      outcomeHint: "A new category escalates until you decide it can merge.",
      remove: "Remove category",
      mergeNoGates: "This category merges with no gates of its own. Only the always-gates stand in the way.",
    },
    fallbackEnd: {
      title: "Fallback",
      body: "Where a pull request goes when it declares a category the policy doesn't define.",
    },
    evaluator: {
      body: "An LLM answers one narrow question about the diff. It can only push a pull request towards escalation.",
      noRunner: "No evaluator runner exists yet, so reaching this node escalates.",
      model: "Model",
      modelDefault: "runner's default",
    },
    add: {
      title: "Add a gate",
      always: "It will run on every pull request.",
      category: (category: string) => `It will run for pull requests declaring ${category}.`,
      cancel: "Cancel",
      defaultFail: (outcome: string) => `fails → ${outcome}`,
    },
  },

  detail: {
    empty: {
      title: "Select a pull request",
      body: "Its path through the policy lights up on the canvas, and its decision is explained here.",
    },
    openOnGitHub: "Open on GitHub",
    by: (author: string) => `by ${author}`,
    declared: "Declared",
    noIntent: "No valid windlass block",
    changes: (files: number, additions: number, deletions: number) =>
      `${files} file${files === 1 ? "" : "s"}, +${additions} −${deletions}`,
    underDraft: "Under the draft",
    underCurrent: "On the default branch",
    same: "The draft decides this pull request the same way.",
    reasons: "Why",
    noReasons: "Every node passed.",
    nodes: "Node by node",
    more: (count: number) => `…and ${count} more`,
  },

  yaml: {
    label: "Policy YAML",
    hint: "Edits here redraw the canvas. Comments are kept when you edit on the canvas too.",
    errors: "Problems",
    wholeFile: "policy",
  },

  errors: {
    generic: "Something went wrong.",
    edit: (message: string) => `Couldn't make that change: ${message}`,
  },
} as const;
