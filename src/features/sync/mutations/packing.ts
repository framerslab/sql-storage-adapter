/**
 * A push's batches: in mutation id order, each holding at most `maxMutations` mutations and at most `maxBytes` bytes of
 * the UTF-8 JSON request it travels in, envelope included. A mutation larger than the limit travels alone, and the
 * server's 413 decides; batches never reorder or renumber.
 */
import type { MutationRecord, PushRequest } from './wire';

const encoder = new TextEncoder();

/** The exact UTF-8 bytes of a push request as the transport sends it. */
export function requestBytes(request: PushRequest): number {
  return encoder.encode(JSON.stringify(request)).length;
}

/** Packs mutations into batches; see the module's comment. */
export function packMutations(
  envelope: Omit<PushRequest, 'mutations'>,
  mutations: readonly MutationRecord[],
  limits: { maxMutations: number; maxBytes: number },
): MutationRecord[][] {
  // the request with no mutation, its whole envelope (the protocol too) and "mutations":[] included; each mutation adds
  // its own bytes and, after the first, a comma
  const head = requestBytes({ ...envelope, mutations: [] });
  const batches: MutationRecord[][] = [];
  let current: MutationRecord[] = [];
  let bytes = head;
  for (const mutation of mutations) {
    const size = encoder.encode(JSON.stringify(mutation)).length;
    const extra = current.length === 0 ? size : size + 1;
    if (current.length > 0 && (current.length >= limits.maxMutations || bytes + extra > limits.maxBytes)) {
      batches.push(current);
      current = [];
      bytes = head;
    }
    bytes += current.length === 0 ? size : size + 1;
    current.push(mutation);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
