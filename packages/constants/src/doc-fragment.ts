/**
 * `DOC_FRAGMENT` — the Y.XmlFragment name every editor binding reads
 * and writes (the doc's canonical block content lives at
 * `ydoc.getXmlFragment(DOC_FRAGMENT)`).
 *
 * Part of the DURABLE FORMAT: the string predates ADR 0038 (it was
 * the BlockNote binding's fragment name) and is persisted inside
 * every `doc_updates` blob — never rename the VALUE without a content
 * migration. Lives in `@editorzero/constants` because both sides of
 * the wire need it and only one may own it: the server write path
 * (`@editorzero/sync` — a Node-only package) and the browser collab
 * binding (`apps/app`'s Tiptap `Collaboration.configure({ field })`)
 * must agree byte-for-byte, and a drift would silently fork content
 * into two fragments on the same doc.
 *
 * Import-free leaf module (the `reserved-prefixes.ts` pattern) so any
 * config-eval context can load it standalone.
 */
export const DOC_FRAGMENT = "document-store";
