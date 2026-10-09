# Security reports

Use [GitHub's private vulnerability reporting](https://github.com/DicksonWu654/sonora/security/advisories/new) for suspected vulnerabilities. Include the Sonora version, platform, and reproduction steps with synthetic text. Do not post private page text, book content, credentials, or podcast/studio URLs in a public issue.

The local server binds to loopback. Cross-origin extension requests are limited to narration endpoints, with studio and feed access handled separately. Do not expose the server directly to the internet; the optional tunnel uses private access links.

Only the current release is maintained. Update the source and reload the browser extension when installing a fix.
