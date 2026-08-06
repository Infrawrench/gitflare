import { Sandbox } from '@cloudflare/sandbox'

/**
 * The container CI commands run in.
 *
 * Subclassed from `@cloudflare/sandbox` rather than from `@cloudflare/ci`'s
 * `CiSandbox`, so the direct runner carries no dependency on the Artifacts-only
 * package. Both end up as the same base class, and both can point at the same
 * image; this one just does not drag Workflows and Artifacts along with it.
 */
export class GitflareSandbox extends Sandbox {}
