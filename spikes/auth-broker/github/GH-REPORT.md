# GitHub CLI routing gate

Validated 2026-09-08 with installed `gh version 2.100.0 (2026-09-03)`.
Run `python3 spikes/auth-broker/github/gh_probe.py`; outputs `gh-results.json`.

The probe uses a fake token, isolated temporary HOME/GH_CONFIG_DIR, a temporary
repository with canonical GitHub SSH remote, and local HTTP/Unix-socket mocks.
HTTP(S) proxy settings route any unexpected external attempt to a rejecting
loopback proxy. No real GitHub token or network request is used.

## Result: use native `http_unix_socket`

`gh config set api_host http://127.0.0.1:PORT --host github.com` is accepted by
`config set` but fails when used. `gh pr list` explicitly requires a hostname
without scheme or port. Therefore api_host is not a direct loopback HTTP route.

`gh config set http_unix_socket /path/to/relay.sock` successfully sends plaintext
HTTP over a Unix domain socket while preserving canonical GitHub identity.
Set `GH_TOKEN=clankerbox-github-placeholder`; real credentials remain external.

Passed:

- `gh api user`: GET `/user`, Host `api.github.com`.
- `gh api graphql -f 'query=query { viewer { login } }'`: POST `/graphql`.
- `gh api --paginate paginate`: follows canonical HTTPS api.github.com Link URL,
  with both pages delivered through the same Unix socket.
- `gh pr list --json number,title,url`: detects repository from
  `git@github.com:owner/repo.git`; GraphQL request succeeds; canonical PR URL kept.
- `gh repo view --json nameWithOwner,url`: returns `owner/repo` and canonical
  `https://github.com/owner/repo` through mocked GraphQL.

- `gh pr create --repo owner/repo --base main --head probe --title fixture
  --body fixture`: repository lookup, existing-PR lookup, and GraphQL
  `createPullRequest` mutation all use the socket. Asserts exact mutation inputs
  and canonical returned PR URL. This creates only a mock PR response; it does
  not contact GitHub or publish a real PR.

Observed auth header: `Authorization: token clankerbox-github-placeholder`.
The controller must overwrite this, route only allowed canonical destinations,
and avoid forwarding the user's credential to arbitrary hosts. The Unix-socket
setting applies broadly to gh HTTP traffic; it is routing, not a host allowlist.

A guest Unix-to-existing-TCP-relay bridge would preserve the current controller
relay architecture without adding a deployed service. Unix socket permissions
should restrict guest access to the intended user, as with the current relays.
This is a routing proof only: no live auth import, GitHub writes, LFS/assets,
real pagination, or lifecycle tests are claimed by this probe.
