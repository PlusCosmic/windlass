import { ciGreen } from "./ci-green.js";
import { noNewSkips } from "./no-new-skips.js";
import { pathsOnly } from "./paths-only.js";
import type { GateDefinition } from "./types.js";

export class GateRegistry {
  private readonly gates = new Map<string, GateDefinition>();

  constructor(gates: Iterable<GateDefinition> = []) {
    for (const gate of gates) this.register(gate);
  }

  register<A>(gate: GateDefinition<A>): this {
    if (this.gates.has(gate.name)) throw new Error(`gate \`${gate.name}\` is already registered`);
    this.gates.set(gate.name, gate as GateDefinition);
    return this;
  }

  get(name: string): GateDefinition | undefined {
    return this.gates.get(name);
  }

  names(): string[] {
    return [...this.gates.keys()];
  }
}

export const builtinGates = [pathsOnly, ciGreen, noNewSkips] as const;

/** A registry with every built-in gate. */
export function defaultGateRegistry(): GateRegistry {
  return new GateRegistry(builtinGates);
}
