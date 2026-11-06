(() => {
  const origin = new URL(location.href).searchParams.get('origin');
  const site = document.querySelector('#site'), status = document.querySelector('#status');
  const allow = document.querySelector('#allow'), deny = document.querySelector('#deny');
  try { site.textContent = new URL(origin).hostname; }
  catch { status.textContent = 'This embedded site is invalid. Return to the document and click Sonora again.'; allow.disabled = deny.disabled = true; return; }

  async function finish(granted) {
    allow.disabled = deny.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'sonora-frame-access', granted });
      if (!response?.ok) throw new Error(response?.error || 'Could not return to your document.');
      window.close();
    } catch (error) {
      status.textContent = error.message;
      allow.disabled = deny.disabled = false;
    }
  }
  allow.addEventListener('click', () => {
    // Call directly in the extension page's click, before any await. An action
    // service worker loses its user gesture while probing frame origins.
    chrome.permissions.request({ origins: [origin] }).then(finish).catch(error => {
      status.textContent = error.message;
    });
  });
  deny.addEventListener('click', () => finish(false));
})();
