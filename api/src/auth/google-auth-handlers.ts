/**
 * Handler-name constants for AuthController's two Google OAuth routes.
 *
 * GoogleAuthGuard tells the authorize leg (`GET /auth/google`) apart from
 * the callback leg (`GET /auth/google/callback`) by comparing
 * `context.getHandler().name` against these — see
 * google-auth.guard.ts#isAuthorizeRoute for why (it decides whether to mint
 * a state nonce or verify one).
 *
 * These live in their own module, rather than being exported from
 * auth.controller.ts directly, specifically to avoid a circular import:
 * auth.controller.ts already imports GoogleAuthGuard (for `@UseGuards`), so
 * having the guard import handler-name constants back out of the controller
 * module makes `@UseGuards(GoogleAuthGuard)`'s decorator evaluate before
 * GoogleAuthGuard has finished being exported, which NestJS rejects at
 * import time ("Invalid guard passed to @UseGuards() decorator"). Routing
 * both the controller and the guard through this leaf module sidesteps that
 * entirely.
 *
 * Previously the guard hardcoded 'googleAuth' as a string literal, and the
 * guard's own unit tests hardcoded it again — so a method rename on
 * AuthController would silently break routing with no compiler error, and
 * the guard's tests would not catch it either. Importing these constants
 * everywhere the literal was duplicated turns that into a one-line grep.
 */
export const GOOGLE_AUTH_HANDLER_NAME = 'googleAuth';
export const GOOGLE_CALLBACK_HANDLER_NAME = 'googleCallback';
