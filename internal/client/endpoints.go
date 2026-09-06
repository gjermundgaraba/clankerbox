package client

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// Endpoint is always a numeric guest loopback destination, with distinct families.
type Endpoint struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

func (e Endpoint) Address() string { return net.JoinHostPort(e.Host, strconv.Itoa(e.Port)) }
func (e Endpoint) Validate() error {
	if (e.Host != "127.0.0.1" && e.Host != "::1") || e.Port < 1 || e.Port > 65535 {
		return errors.New("forward destination must be 127.0.0.1 or ::1 and port 1..65535")
	}
	return nil
}
func parsePort(s string) (int, error) {
	if s == "" {
		return 0, errors.New("missing numeric port")
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("invalid numeric port")
		}
	}
	p, e := strconv.Atoi(s)
	if e != nil || p < 1 || p > 65535 {
		return 0, errors.New("port must be 1..65535")
	}
	return p, nil
}
func ParseEndpoint(s string) (Endpoint, error) {
	h, p, e := net.SplitHostPort(s)
	if e != nil {
		return Endpoint{}, errors.New("forward must be numeric loopback HOST:PORT (bracket IPv6)")
	}
	n, e := parsePort(p)
	if e != nil {
		return Endpoint{}, e
	}
	ep := Endpoint{h, n}
	return ep, ep.Validate()
}

const LinuxDiscoveryCommand = "ss -H -ltn"
const MacDiscoveryCommand = "lsof -nP -iTCP -sTCP:LISTEN -F n"

func DiscoveryCommand(os string) (string, error) {
	switch os {
	case "linux":
		return LinuxDiscoveryCommand, nil
	case "macos":
		return MacDiscoveryCommand, nil
	}
	return "", errors.New("unsupported guest OS")
}
func discoveryEndpoint(s string) []Endpoint {
	i := strings.LastIndexByte(s, ':')
	if i < 1 {
		return nil
	}
	host := s[:i]
	if strings.ContainsAny(host, "[]") {
		if len(host) < 3 || host[0] != '[' || host[len(host)-1] != ']' || strings.ContainsAny(host[1:len(host)-1], "[]") {
			return nil
		}
		host = host[1 : len(host)-1]
	}
	p, e := parsePort(s[i+1:])
	if e != nil || p < 1024 || p == 5900 {
		return nil
	}
	// An unqualified wildcard has no family information; probe both loopbacks.
	if host == "*" {
		return []Endpoint{{"127.0.0.1", p}, {"::1", p}}
	}
	a, e := netip.ParseAddr(host)
	if e != nil || a.Zone() != "" || (!a.IsLoopback() && !a.IsUnspecified()) {
		return nil
	}
	// Other 127/8 addresses are not rewritten to a different listener.
	if a.Is4() {
		if a.String() != "127.0.0.1" && !a.IsUnspecified() {
			return nil
		}
		return []Endpoint{{"127.0.0.1", p}}
	}
	if a.Is4In6() {
		return nil
	}
	return []Endpoint{{"::1", p}}
}
func ParseListeners(os, output string) ([]Endpoint, error) {
	if _, e := DiscoveryCommand(os); e != nil {
		return nil, e
	}
	found := map[Endpoint]bool{}
	scan := bufio.NewScanner(strings.NewReader(output))
	scan.Buffer(make([]byte, 4096), 64*1024)
	for scan.Scan() {
		line := scan.Text()
		var address string
		if os == "linux" {
			f := strings.Fields(line)
			if len(f) < 5 || f[0] != "LISTEN" {
				continue
			}
			address = f[3]
		} else {
			if !strings.HasPrefix(line, "n") {
				continue
			}
			address = line[1:]
		}
		for _, ep := range discoveryEndpoint(address) {
			found[ep] = true
		}
	}
	if e := scan.Err(); e != nil {
		return nil, errors.New("oversized discovery record")
	}
	out := make([]Endpoint, 0, len(found))
	for e := range found {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Host != out[j].Host {
			return out[i].Host < out[j].Host
		}
		return out[i].Port < out[j].Port
	})
	return out, nil
}

type Mapping struct {
	MachineID string   `json:"machine_id"`
	Guest     Endpoint `json:"guest"`
	Local     string   `json:"local,omitempty"`
	Available bool     `json:"available"`
	Error     string   `json:"error,omitempty"`
}

// RewriteURL resolves only exact numeric endpoints from available mappings.
// localhost and family-unspecified '*' prefer IPv4, then IPv6.
func RewriteURL(raw string, mappings []Mapping, allowExternal bool) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Opaque != "" || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || strings.ContainsAny(raw, "\r\n\x00") {
		return "", errors.New("URL must be http(s) without credentials")
	}
	h := strings.ToLower(u.Hostname())
	h = strings.TrimSuffix(h, ".")
	if strings.Contains(u.Host, "[") {
		if _, err := netip.ParseAddr(h); err != nil {
			return "", errors.New("invalid bracketed URL address")
		}
	}
	local := h == "localhost" || h == "*"
	family := ""
	if a, e := netip.ParseAddr(h); e == nil {
		if a.Zone() != "" {
			return "", errors.New("scoped URL addresses are unsupported")
		}
		local = a.IsLoopback() || a.IsUnspecified()
		if local {
			if a.Is4() {
				if a.String() != "127.0.0.1" && !a.IsUnspecified() {
					return "", errors.New("unsupported loopback address")
				}
				family = "127.0.0.1"
			} else if !a.Is4In6() {
				family = "::1"
			} else {
				return "", errors.New("IPv4-mapped URL addresses are unsupported")
			}
		}
	} else if ambiguousNumericHost(h) {
		return "", errors.New("ambiguous numeric URL address")
	}
	port := 80
	if u.Scheme == "https" {
		port = 443
	}
	if u.Port() != "" {
		port, e = parsePort(u.Port())
		if e != nil {
			return "", e
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return "", errors.New("empty URL port")
	}
	if !local {
		if allowExternal {
			return raw, nil
		}
		return "", errors.New("URL host must be loopback or wildcard")
	}
	families := []string{family}
	if family == "" {
		families = []string{"127.0.0.1", "::1"}
	}
	for _, f := range families {
		for _, m := range mappings {
			if m.Guest == (Endpoint{f, port}) && m.Available {
				ep, e := ParseEndpoint(m.Local)
				if e != nil {
					return "", errors.New("invalid local mapping")
				}
				u.Host = ep.Address()
				return u.String(), nil
			}
		}
	}
	return "", fmt.Errorf("no available forward for guest port %d", port)
}

// Browsers normalize abbreviated, octal and hexadecimal IPv4 spellings. Never
// pass these through as external hosts where they could reach an unrelated local service.
func ambiguousNumericHost(host string) bool {
	for _, part := range strings.Split(host, ".") {
		if part == "" {
			return true
		}
		base := 10
		if strings.HasPrefix(part, "0x") {
			part = part[2:]
			base = 16
		}
		if _, err := strconv.ParseUint(part, base, 64); err != nil {
			return false
		}
	}
	return true
}
