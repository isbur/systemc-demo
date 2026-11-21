/*!
 * Old registration lived at app/ (scope app/). pthread-host/ is outside that
 * scope, so the worker URL got a GitHub Pages HTML 404 and Firefox blocked
 * it as a bad MIME type. This file now hands control to the parent SW.
 */
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => {
          clients.forEach((client) => client.navigate(client.url));
        }),
    );
  });
} else {
  const parent = new URL('../coi-serviceworker.js', document.currentScript.src);
  const script = document.createElement('script');
  script.src = parent.href;
  document.currentScript.after(script);
}
