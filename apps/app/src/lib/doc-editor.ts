/**
 * `doc.get` + `doc.update` data-layer — the editor cells' policy module
 * (invariant 4, ADR 0033 §3 / ADR 0038 HTTP-first editor).
 *
 * Same split as `docs.ts`: plain testable functions here; the route +
 * editor component stay render/orchestration-only (e2e-covered, proven
 * by the marked Playwright spec). Everything content-shaped flows
 * through `@editorzero/blocks` — the SAME module the server applier
 * uses — so the browser diff, the precondition hashes, and the wire
 * parse share one implementation with the other side of the HTTP call.
 *
 * Save model (HTTP-first, ADR 0038): the editor keeps the loaded
 * blocks as its BASE; Save diffs base → current into `doc.update` ops,
 * stamping `expect_prior_content_hash` per touched block from the
 * base's content. A concurrent writer therefore surfaces as a 409
 * (`conflict`), never a silent overwrite; the v1 policy is
 * reload-and-discard (the CRDT live-sync lane is a later slice).
 */
import { type ApiClient, ApiError, isApiError } from "@editorzero/api-client";
import { type Block, diffBlocksToOps, hashBlockContent, parseBlocks } from "@editorzero/blocks";
import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import { readErrorCode } from "./wire-error";

type DocGetResponse = Awaited<ReturnType<ApiClient["docs"]["get"][":doc_id"]["$get"]>>;
type DocGetSuccess = Extract<DocGetResponse, { status: 200 }>;
type DocGetBody = Awaited<ReturnType<DocGetSuccess["json"]>>;
/** Doc metadata as the wire carries it (branded ids — see session.ts NB). */
export type DocMeta = DocGetBody["doc"];

/** The ops array exactly as `doc.update` accepts it over the wire. */
export type SaveOps = ReturnType<typeof diffBlocksToOps>;

export interface DocData {
  readonly doc: DocMeta;
  readonly blocks: readonly Block[];
}

export function docQueryKey(docId: string) {
  return ["doc.get", docId] as const;
}

/**
 * Fetch one doc. The wire carries `blocks` as `unknown[]` (the schemas
 * leaf keeps the block union out — ADR 0034); `parseBlocks` re-validates
 * against the owned model, so everything downstream works on canonical
 * `Block[]`, not trust-me JSON.
 */
export async function fetchDoc(docId: string, client: ApiClient = apiClient): Promise<DocData> {
  const res = await client.docs.get[":doc_id"].$get({ param: { doc_id: docId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  const body = await res.json();
  return { doc: body.doc, blocks: parseBlocks(body.blocks) };
}

export function docQueryOptions(docId: string, client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: docQueryKey(docId),
    queryFn: () => fetchDoc(docId, client),
  });
}

/**
 * Diff the loaded base against the editor's current state into
 * `doc.update` ops, with every touched base block carrying its
 * `expect_prior_content_hash` (computed with the same WebCrypto
 * canonical-JSON hash the server verifies). `[]` means "nothing to
 * save".
 */
export async function buildSaveOps(
  base: readonly Block[],
  current: readonly Block[],
): Promise<SaveOps> {
  const hashes = new Map<string, string>();
  for (const block of base) {
    hashes.set(block.id, await hashBlockContent(block));
  }
  return diffBlocksToOps(base, current, hashes);
}

/** POST the ops batch; resolves on 200, throws a typed `ApiError` otherwise. */
export async function saveDoc(
  docId: string,
  ops: SaveOps,
  client: ApiClient = apiClient,
): Promise<void> {
  const res = await client.docs.update[":doc_id"].$post({
    param: { doc_id: docId },
    json: { ops },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
}

export type SaveFailure = "conflict" | "save_failed";

/**
 * 409 is the one failure with its own UX arm: the base the user edited
 * from is stale (another writer landed first — the hash precondition
 * fired). Everything else is a generic retryable failure; auth-shaped
 * errors bubble through the same surface (the route guard owns session
 * loss).
 */
export function classifySaveError(error: unknown): SaveFailure {
  return isApiError(error) && error.status === 409 ? "conflict" : "save_failed";
}

export function saveFailureMessage(kind: SaveFailure): string {
  return kind === "conflict"
    ? "This doc changed on the server while you were editing. Reload to get the latest version — unsaved edits here will be discarded."
    : "Save failed. Your edits are still here — try again.";
}
