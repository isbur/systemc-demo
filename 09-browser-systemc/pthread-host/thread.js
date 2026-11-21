/**
 * Old Worker URL. GitHub Pages must serve JavaScript here, not the HTML 404.
 * The real worker (COEP via the parent service worker / app/ copy) is imported
 * for side effects so a cached sim-host.js still boots a thread.
 */
import '../app/thread.js';
