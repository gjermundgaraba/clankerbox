# Controller-managed GitHub authentication

GitHub uses the same encrypted controller connection store as Codex and Claude.
Every prepared machine automatically receives access to connected providers;
there is no per-machine attach command. Disconnecting GitHub removes access
through its controller connection for all machines.

Connect using the GitHub CLI login on your local machine:

```sh
clankerbox auth connect github
```

Alternatively, provide a token on standard input with
`clankerbox auth connect github --token-stdin`. The token's existing repository
permissions apply. Imported tokens are not automatically refreshed; expired or
revoked credentials need to be replaced by connecting again.

Inside a prepared VM, use ordinary commands:

```sh
git clone git@github.com:owner/private-repo.git
cd private-repo
git fetch
gh pr list
```

GitHub CLI and Git must be installed in the guest. The routing experiment used
GitHub CLI 2.100.0; older versions must support `http_unix_socket`.

## Routing and snapshots

Public configuration under `/etc/clankerbox` points GitHub CLI at the guest Unix
socket `/tmp/clankerbox-gh.sock`. SSH sessions receive `GH_CONFIG_DIR` from sshd;
managed lines in the default user's shell profiles also supply it to interactive
shells. The shared hosts configuration contains only a placeholder token.

A managed include in the default user's `.gitconfig` rewrites GitHub HTTPS,
`git@github.com:`, and `ssh://git@github.com/` URLs to the loopback Git relay.
Existing Git identity settings are preserved. GitHub CLI continues to recognize
canonical GitHub repository names and URLs.

The controller stores the real token and inserts it only into permitted GitHub
requests. Neither config files nor VM memory need the real token. Forks and
restores receive their own automatically established controller relays; copied
socket paths and placeholder values do not independently grant access.

The socket is accessible to guest processes, like the existing loopback relay.
This design isolates credentials from snapshots, not one process from another
within the same VM. Existing processes with an explicitly overridden
`GH_CONFIG_DIR` or GitHub authentication environment variables can override the
managed CLI configuration.

## Initial scope

Routing covers ordinary Git clone/fetch/push over GitHub HTTPS and GitHub CLI
REST/GraphQL operations, including pagination. GitHub Enterprise hosts are not
configured. LFS, release assets, Actions artifacts, and other flows involving
additional hosts or download redirects need separate validation and are not
claimed as supported by this initial integration. Git configuration used by
submodules may add further routing requirements.

The offline routing proof and captured fake-credential requests are in
[`spikes/auth-broker/github`](../spikes/auth-broker/github/). Live authentication
and lifecycle validation is recorded in the same directory as separate live results.
The routing proof uses synthetic credentials and a local Git backend.

## Validation: 2026-09-08

Routing was proven before implementation: actual Git clone/fetch/push passed for
all three URL forms against a local backend. Native GitHub CLI 2.100.0 passed
mock REST, GraphQL, pagination, repository detection, PR listing and PR creation.
All captured mock requests carried only placeholder credentials. `api_host` was
unsuitable for loopback HTTP; `http_unix_socket` preserved canonical GitHub hosts
and pagination routing without an extra guest process.

The deployed controller imported the operator's existing local GitHub CLI login.
A disposable Linux VM authenticated with ordinary `gh api user`, cloned a private
repository from an SSH-style URL without a `.git` suffix, and ran `gh repo view`
and `gh pr list`. The guest `gh auth token` returned only the public placeholder.
Live repository operations were read-only; push and PR creation were tested with
local mocks, not against the operator's repository.

A Linux RAM fork automatically received a new Unix-socket relay: ordinary `gh`
authentication and a private Git fetch passed in the child, and the parent remained
usable. Both returned only the public placeholder from `gh auth token`. macOS
passed ordinary `gh` authentication and private Git cloning after automatic
preparation, including its non-root guest user and read-only shared config.

The complete Go race suite, lint, secret scans, infrastructure validation and
database integrity passed. The new Unix-socket path was not separately tested
through checkpoint restore or controller restart in this deployment; those
lifecycle paths previously passed for the TCP relay. Unit tests cover bounded
shutdown of both listeners, including an unresponsive guest.

All three disposable GitHub test VMs were stopped and deleted. The existing
`clankerdesk-test` VM remains running with its relay ready. Codex, Claude and
GitHub connections remain ready for automatic use.
