# Security

No credentials, Codex auth state, database dumps, user uploads, generated media, browser captures or deployment addresses belong in Git. Environment examples contain placeholders only. Keep credentials in ignored local files or protected server environment files, with distinct application/database roles.

The export contains no public IP literals. Replace example LAN hosts and movie.example.com locally. Configure CROWDMOVIE_TRUSTED_PROXIES with your actual ingress addresses/CIDRs and configure Caddy consistently; never set trustProxy=true on a public origin.

Use `python3 scripts/check-public-source.py` and `gitleaks git . --redact` before publishing. The scanner reports locations/categories without printing secret values. Do not add broad allowlists to silence real findings.

Runtime content models must not inherit worker secrets or execute state changes. Database state transitions, input paths, workflow/model allowlists, duration checks and publication verification remain server-owned. Keep ComfyUI and H3 behind private networking; the gateway client allowlist is not internet authentication.

Report vulnerabilities privately to the repository maintainers through available GitHub private reporting channels. Never attach a live token, deployment address, user data or unredacted log to an issue.
