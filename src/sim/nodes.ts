// Engine node graph model + selection (ported from node_s.h).

import { type Chamber, normalizeChamber, normalizeInjectionChamber } from "./chamber";
import { type PowerCell, type Valve } from "./mechanical";

export const NodeType = {
  chamber: 0,
  source: 1,
  afilter: 2,
  throttle: 3,
  iplenum: 4,
  injector: 5,
  irunner: 6,
  piston: 7,
  erunner: 8,
  eplenum: 9,
  exhaust: 10,
  sink: 11,
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

export const NODE_NAME_STRING = [
  "chamber", "source", "afilter", "throttle", "iplenum", "injector",
  "irunner", "piston", "erunner", "eplenum", "exhaust", "sink",
];

export class Node {
  type: NodeType = NodeType.chamber;
  chamber: Chamber;
  piston: PowerCell | null = null; // piston / rotor nodes
  valve: Valve | null = null; // irunner nodes
  waveIndex = 0; // eplenum nodes
  useCfd = false; // eplenum nodes
  pipeLengthM = 0; // eplenum
  micPositionRatio = 0; // eplenum
  velocityLowPassCutoffFrequencyHz = 0; // eplenum
  nozzleIndex = 0; // injector nodes
  next: number[] = [];
  is_selected = false;
  is_next_selected = false;
  constructor(chamber: Chamber) {
    this.chamber = chamber;
  }
}

export const isReservoir = (n: Node): boolean =>
  n.type === NodeType.injector ||
  n.type === NodeType.source ||
  n.type === NodeType.sink;

export function normalizeNode(n: Node): void {
  if (n.type === NodeType.injector) normalizeInjectionChamber(n.chamber);
  else normalizeChamber(n.chamber);
}

export const countNodeEdges = (n: Node): number => n.next.length;

export function removeNextSelected(nodes: Node[]): void {
  for (const n of nodes) n.is_next_selected = false;
}

export function deselectAllNodes(nodes: Node[]): void {
  removeNextSelected(nodes);
  for (const n of nodes) n.is_selected = false;
}

export function selectNodes(nodes: Node[], type: NodeType): void {
  removeNextSelected(nodes);
  for (const n of nodes) {
    if (n.type === type) n.is_selected = true;
  }
}

export function countSelectedNodes(nodes: Node[]): number {
  let c = 0;
  for (const n of nodes) if (n.is_selected) c++;
  return c;
}

export function selectNext(nodes: Node[]): void {
  if (countSelectedNodes(nodes) !== 1) return;
  for (const n of nodes) {
    if (n.is_selected) {
      for (const next of n.next) {
        n.is_next_selected = true;
        nodes[next].is_selected = true;
      }
      break;
    }
  }
}
