package host

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"clankerbox/internal/model"
)

// PrepareAuth installs a public relay key and launcher through the trusted runtime channel.
func (h *Helper) PrepareAuth(ctx context.Context, id, publicKey string) (resultErr error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lock, err := h.state.Lock(".lock", true)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()
	if !model.ValidID(id) {
		return errors.New("invalid machine ID")
	}
	keys, err := model.ValidateKeys([]string{publicKey})
	if err != nil || len(keys) != 1 {
		return errors.New("invalid relay public key")
	}
	m, err := h.manifest(ctx, id)
	if err != nil {
		return err
	}
	if !m.Prepared || m.Deleted {
		return errors.New("machine is not prepared")
	}
	var body []byte
	if err = h.db.QueryRowContext(ctx, "SELECT body FROM operations WHERE machine_id=? AND generation=?", id, m.Generation).
		Scan(&body); err != nil {
		return err
	}
	var op accepted
	if err = json.Unmarshal(body, &op); err != nil {
		return err
	}
	if op.Response.Status != statusSucceeded {
		return errors.New("machine operation is unresolved")
	}
	obs, err := h.observation(ctx, m)
	if err != nil {
		return err
	}
	if obs.State != model.Running {
		return errors.New("machine is not running")
	}
	if err = validEndpoint(m, obs.Endpoint); err != nil {
		return err
	}
	rt, ok := h.runtime.(interface {
		PrepareAuth(context.Context, Manifest, string) error
	})
	if !ok {
		return errors.New("runtime does not support auth relay preparation")
	}
	return rt.PrepareAuth(ctx, m, keys[0])
}

// PrepareAuth installs the relay configuration in an already running guest.
func (n *NativeRuntime) PrepareAuth(ctx context.Context, m Manifest, publicKey string) error {
	script, err := authScript(m, publicKey)
	if err != nil {
		return err
	}
	call, cancel := context.WithTimeout(ctx, guestReadyTimeout)
	defer cancel()
	_, err = n.guest(call, m, script)
	return err
}

const (
	authRootUser = "root"
	authMacUser  = "admin"
)

func authScript(m Manifest, publicKey string) (string, error) {
	if !model.ValidID(m.ID) {
		return "", errors.New("invalid machine ID")
	}
	keys, err := model.ValidateKeys([]string{publicKey})
	if err != nil || len(keys) != 1 {
		return "", errors.New("invalid relay public key")
	}
	user, home, decode := authRootUser, rootHome, linuxDecode
	if m.Profile.Runtime == runtimeTart {
		user, home, decode = authMacUser, adminHome, macDecode
	}
	// PermitOpen remains loopback-only globally. This disjoint key restriction
	// disables local forwards while allowing the remote TCP and Unix relay listeners.
	line := `restrict,port-forwarding,permitlisten="127.0.0.1:18443",permitopen="clankerbox-auth.invalid:1",command="/bin/false" ` + keys[0] + " clankerbox-auth-relay"
	encoded := base64.StdEncoding.EncodeToString([]byte(line + "\n"))
	script := "set -eu\numask 077\ntest \"$(cat /etc/clankerbox/owner)\" = '" + m.ID + "'\n" +
		"mkdir -p '" + home + "/.ssh'\nkeys='" + home + "/.ssh/authorized_keys'\ntest -f \"$keys\"\n" +
		"awk '$NF != \"clankerbox-auth-relay\"' \"$keys\" > \"$keys.auth-tmp\"\nprintf '%s' '" + encoded + "' | " + decode + " >> \"$keys.auth-tmp\"\nchmod 600 \"$keys.auth-tmp\"\nchown '" + user + "' \"$keys.auth-tmp\"\nmv \"$keys.auth-tmp\" \"$keys\"\n" +
		"awk '!/^AllowTcpForwarding / && !/^PermitListen / && !/^AllowStreamLocalForwarding / && !/^StreamLocalBindMask / && !/^StreamLocalBindUnlink /' /etc/ssh/sshd_config > /etc/ssh/sshd_config.auth-tmp\nprintf '%s\\n' 'AllowTcpForwarding yes' 'PermitListen 127.0.0.1:18443' 'AllowStreamLocalForwarding remote' 'StreamLocalBindMask 0111' 'StreamLocalBindUnlink yes' >> /etc/ssh/sshd_config.auth-tmp\n/usr/sbin/sshd -t -f /etc/ssh/sshd_config.auth-tmp\nmv /etc/ssh/sshd_config.auth-tmp /etc/ssh/sshd_config\n"
	wrapper := "#!/bin/sh\nexec codex -c 'model_provider=\"clankerbox\"' -c 'model_providers.clankerbox={name=\"OpenAI\",base_url=\"http://127.0.0.1:18443/v1\",wire_api=\"responses\",requires_openai_auth=false,supports_websockets=false}' \"$@\"\n"
	wrapperData := base64.StdEncoding.EncodeToString([]byte(wrapper))
	script += "mkdir -p /usr/local/bin\nprintf '%s' '" + wrapperData + "' | " + decode + " > /usr/local/bin/clankerbox-codex.auth-tmp\nchmod 755 /usr/local/bin/clankerbox-codex.auth-tmp\nmv /usr/local/bin/clankerbox-codex.auth-tmp /usr/local/bin/clankerbox-codex\n"
	claudeData := base64.StdEncoding.EncodeToString([]byte(claudeAuthWrapper()))
	script += "printf '%s' '" + claudeData + "' | " + decode + " > /usr/local/bin/clankerbox-claude.auth-tmp\nchmod 755 /usr/local/bin/clankerbox-claude.auth-tmp\nmv /usr/local/bin/clankerbox-claude.auth-tmp /usr/local/bin/clankerbox-claude\n"
	script += githubAuthScript(user, home)
	var b strings.Builder
	b.WriteString(script)
	writeSSHDStart(&b, m.Profile.Runtime, false)
	script = b.String()
	if m.Profile.Runtime == runtimeTart {
		script = "sudo -n /bin/bash -se <<'CLANKERBOX_AUTH_PREPARE'\n" + script + "CLANKERBOX_AUTH_PREPARE\n"
	}
	return script, nil
}

// claudeAuthWrapper keeps only public relay configuration in the guest. The
// launch settings override conflicting user/project env without changing their
// files or disabling unrelated settings. Managed policy can still take priority.
func claudeAuthWrapper() string {
	return `#!/bin/sh
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_MANTLE
export ANTHROPIC_BASE_URL=http://127.0.0.1:18443
export CLAUDE_CODE_OAUTH_TOKEN=clankerbox-controller-managed
exec claude --settings '{"apiKeyHelper":"","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:18443","CLAUDE_CODE_OAUTH_TOKEN":"clankerbox-controller-managed","ANTHROPIC_API_KEY":"","ANTHROPIC_AUTH_TOKEN":"","ANTHROPIC_CUSTOM_HEADERS":"","CLAUDE_CODE_OAUTH_REFRESH_TOKEN":"","CLAUDE_CODE_OAUTH_SCOPES":"","CLAUDE_CODE_USE_BEDROCK":"","CLAUDE_CODE_USE_VERTEX":"","CLAUDE_CODE_USE_FOUNDRY":"","CLAUDE_CODE_USE_ANTHROPIC_AWS":"","CLAUDE_CODE_USE_MANTLE":""}}' "$@"
`
}

// githubAuthScript installs public routing only. The controller authenticates
// requests arriving through the Unix gh socket or Git's loopback HTTP endpoint.
func githubAuthScript(user, home string) string {
	return `mkdir -p /etc/clankerbox/gh
chmod 755 /etc/clankerbox /etc/clankerbox/gh
cat > /etc/clankerbox/gh/config.yml <<'CLANKERBOX_GH_CONFIG'
version: "1"
http_unix_socket: /tmp/clankerbox-gh.sock
git_protocol: https
CLANKERBOX_GH_CONFIG
cat > /etc/clankerbox/gh/hosts.yml <<'CLANKERBOX_GH_HOSTS'
github.com:
    oauth_token: clankerbox-controller-managed
    git_protocol: https
CLANKERBOX_GH_HOSTS
cat > /etc/clankerbox/gitconfig <<'CLANKERBOX_GIT_CONFIG'
[url "http://127.0.0.1:18443/github/git/"]
    insteadOf = https://github.com/
    insteadOf = git@github.com:
    insteadOf = ssh://git@github.com/
CLANKERBOX_GIT_CONFIG
chmod 644 /etc/clankerbox/gh/config.yml /etc/clankerbox/gh/hosts.yml /etc/clankerbox/gitconfig
# Preserve unrelated SetEnv values, particularly the guest's managed PATH.
awk '$1 == "SetEnv" { line="SetEnv"; for (i=2;i<=NF;i++) if ($i !~ /^GH_CONFIG_DIR=/) line=line " " $i; if (!added++) line=line " GH_CONFIG_DIR=/etc/clankerbox/gh"; if (line != "SetEnv") print line; next } {print} END {if (!added) print "SetEnv GH_CONFIG_DIR=/etc/clankerbox/gh"}' /etc/ssh/sshd_config > /etc/ssh/sshd_config.auth-tmp
/usr/sbin/sshd -t -f /etc/ssh/sshd_config.auth-tmp
mv /etc/ssh/sshd_config.auth-tmp /etc/ssh/sshd_config
` + "home='" + home + "'\n" + `touch "$home/.gitconfig"
if ! grep -Fqx '    path = /etc/clankerbox/gitconfig' "$home/.gitconfig"; then
    printf '\n[include]\n    path = /etc/clankerbox/gitconfig\n' >> "$home/.gitconfig"
fi
for profile in .profile .bashrc .zshrc; do
    touch "$home/$profile"
    if ! grep -Fqx 'export GH_CONFIG_DIR=/etc/clankerbox/gh # clankerbox-managed-github' "$home/$profile"; then
        printf '\n%s\n' 'export GH_CONFIG_DIR=/etc/clankerbox/gh # clankerbox-managed-github' >> "$home/$profile"
    fi
 done
` + "chown '" + user + "' \"$home/.gitconfig\" \"$home/.profile\" \"$home/.bashrc\" \"$home/.zshrc\"\n"
}
