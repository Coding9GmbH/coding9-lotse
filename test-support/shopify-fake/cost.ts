/**
 * Query cost calculation and leaky-bucket throttling modelled on
 * https://shopify.dev/docs/api/usage/limits#cost-calculation
 *
 *   scalar / enum field   0
 *   object field          1
 *   connection field      2 + (first|last) * cost of one node
 *   mutation root field   10
 */
import { Engine, namedType, type FieldNode, type PreparedRequest, type SelectionSetNode } from './graphql';

export const SINGLE_QUERY_MAX_COST = 1000;

export function calculateRequestedCost(engine: Engine, prepared: PreparedRequest): number {
  const schema = engine.schema;
  const fieldDef = (typeName: string, name: string) => {
    const t = schema.types.get(typeName);
    return t && (t.kind === 'OBJECT' || t.kind === 'INTERFACE') ? t.fields.get(name) : undefined;
  };
  const isLeaf = (typeName: string) => {
    const k = schema.types.get(typeName)?.kind;
    return k === 'SCALAR' || k === 'ENUM';
  };
  const sets = (nodes: FieldNode[]) => nodes.map((n) => n.selectionSet).filter((s): s is SelectionSetNode => Boolean(s));

  const costOf = (typeName: string, selection: SelectionSetNode[], depth: number): number => {
    if (depth > 30) return 0;
    let total = 0;
    for (const { nodes, typeName: t } of engine.collectFieldsLoose(typeName, selection, prepared).values()) {
      const node = nodes[0];
      if (node.name === '__typename') continue;
      const def = fieldDef(t, node.name);
      if (!def) continue;
      if (t === 'Mutation') {
        total += 10;
        continue;
      }
      const ret = namedType(def.type);
      if (isLeaf(ret)) continue;
      if (ret.endsWith('Connection')) {
        let size = 0;
        try {
          const args = engine.argumentValues(def, node, prepared.variables) as { first?: number; last?: number };
          size = Number(args.first ?? args.last ?? 0);
        } catch {
          size = 0;
        }
        let perNode = 0;
        for (const inner of engine.collectFieldsLoose(ret, sets(nodes), prepared).values()) {
          const innerNode = inner.nodes[0];
          const innerDef = fieldDef(ret, innerNode.name);
          if (!innerDef) continue;
          if (innerNode.name === 'nodes') {
            perNode = Math.max(perNode, 1 + costOf(namedType(innerDef.type), sets(inner.nodes), depth + 1));
          } else if (innerNode.name === 'edges') {
            const edgeType = namedType(innerDef.type);
            for (const e of engine.collectFieldsLoose(edgeType, sets(inner.nodes), prepared).values()) {
              if (e.nodes[0].name !== 'node') continue;
              const nodeDef = fieldDef(edgeType, 'node');
              if (nodeDef) perNode = Math.max(perNode, 1 + costOf(namedType(nodeDef.type), sets(e.nodes), depth + 1));
            }
          }
        }
        total += 2 + Math.min(size, 250) * perNode;
      } else {
        total += 1 + costOf(ret, sets(nodes), depth + 1);
      }
    }
    return total;
  };
  const root = prepared.operation.operation === 'mutation' ? 'Mutation' : 'Query';
  return costOf(root, [prepared.operation.selectionSet], 0);
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export class ThrottleBucket {
  maximumAvailable: number;
  restoreRate: number;
  private available: number;
  private last = Date.now();

  constructor(opts: { maximumAvailable?: number; restoreRate?: number } = {}) {
    this.maximumAvailable = opts.maximumAvailable ?? 2000;
    this.restoreRate = opts.restoreRate ?? 100;
    this.available = this.maximumAvailable;
  }

  private refill(): void {
    const now = Date.now();
    this.available = Math.min(this.maximumAvailable, this.available + ((now - this.last) / 1000) * this.restoreRate);
    this.last = now;
  }

  get currentlyAvailable(): number {
    this.refill();
    return Math.floor(this.available);
  }

  /** Test hook: drain or fill the bucket. */
  set currentlyAvailable(v: number) {
    this.available = Math.max(0, Math.min(this.maximumAvailable, v));
    this.last = Date.now();
  }

  tryConsume(cost: number): boolean {
    this.refill();
    if (cost > this.available) return false;
    this.available -= cost;
    return true;
  }

  refund(amount: number): void {
    this.available = Math.min(this.maximumAvailable, this.available + amount);
  }

  status(): ThrottleStatus {
    return { maximumAvailable: this.maximumAvailable, currentlyAvailable: this.currentlyAvailable, restoreRate: this.restoreRate };
  }

  reset(): void {
    this.available = this.maximumAvailable;
    this.last = Date.now();
  }
}
