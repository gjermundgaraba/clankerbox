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

// Address formats the numeric endpoint, including IPv6 brackets.
func (e Endpoint) Address() string { return net.JoinHostPort(e.Host, strconv.Itoa(e.Port)) }

// Validate rejects non-loopback destinations and invalid ports.
func (e Endpoint) Validate() error {
	if (e.Host != ipv4Loopback && e.Host != ipv6Loopback) || e.Port < 1 || e.Port > 65535 {
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

// ParseEndpoint parses an explicit numeric loopback destination.
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

// LinuxDiscoveryCommand lists listening TCP sockets without resolving names.
const LinuxDiscoveryCommand = "ss -H -ltn"

// MacDiscoveryCommand lists listening TCP sockets in machine-readable form.
const MacDiscoveryCommand = "lsof -nP -iTCP -sTCP:LISTEN -F n"

// DiscoveryCommand selects the fixed listener query for a supported guest OS.
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
		if len(host) < 3 || host[0] != '[' || host[len(host)-1] != ']' ||
			strings.ContainsAny(host[1:len(host)-1], "[]") {
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
		return []Endpoint{{ipv4Loopback, p}, {ipv6Loopback, p}}
	}
	a, e := netip.ParseAddr(host)
	if e != nil || a.Zone() != "" || (!a.IsLoopback() && !a.IsUnspecified()) {
		return nil
	}
	// Other 127/8 addresses are not rewritten to a different listener.
	if a.Is4() {
		if a.String() != ipv4Loopback && !a.IsUnspecified() {
			return nil
		}
		return []Endpoint{{ipv4Loopback, p}}
	}
	if a.Is4In6() {
		return nil
	}
	return []Endpoint{{ipv6Loopback, p}}
}

// ParseListeners extracts eligible numeric loopback destinations from bounded discovery output.
func ParseListeners(os, output string) ([]Endpoint, error) {
	if _, e := DiscoveryCommand(os); e != nil {
		return nil, e
	}
	found := map[Endpoint]bool{}
	scan := bufio.NewScanner(strings.NewReader(output))
	scan.Buffer(make([]byte, initialScanBufferBytes), maxDiscoveryLineBytes)
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

// Mapping describes a durable local socket and its current guest availability.
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
	if e != nil || u.Opaque != "" || u.Host == "" || (u.Scheme != "http" && u.Scheme != httpsScheme) || u.User != nil ||
		strings.ContainsAny(raw, "\r\n\x00") {
		return "", errors.New("URL must be http(s) without credentials")
	}
	local, family, hostErr := urlHostFamily(u)
	if hostErr != nil {
		return "", hostErr
	}
	port := 80
	if u.Scheme == httpsScheme {
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
	return rewriteLocalURL(u, family, port, mappings)
}

// Browsers normalize abbreviated, octal and hexadecimal IPv4 spellings. Never
// pass these through as external hosts where they could reach an unrelated local service.
func ambiguousNumericHost(host string) bool {
	for part := range strings.SplitSeq(host, ".") {
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

const (
	httpsScheme  = "https"
	ipv4Loopback = "127.0.0.1"
	ipv6Loopback = "::1"
)

func urlHostFamily(u *url.URL) (bool, string, error) {
	h := strings.ToLower(u.Hostname())
	h = strings.TrimSuffix(h, ".")
	if strings.Contains(u.Host, "[") {
		if _, err := netip.ParseAddr(h); err != nil {
			return false, "", errors.New("invalid bracketed URL address")
		}
	}
	local := h == "localhost" || h == "*"
	family := ""
	address, parseErr := netip.ParseAddr(h)
	if parseErr != nil {
		if ambiguousNumericHost(h) {
			return false, "", errors.New("ambiguous numeric URL address")
		}
		return local, family, nil
	}
	if address.Zone() != "" {
		return false, "", errors.New("scoped URL addresses are unsupported")
	}
	if !address.IsLoopback() && !address.IsUnspecified() {
		return false, "", nil
	}
	switch {
	case address.Is4():
		if address.String() != ipv4Loopback && !address.IsUnspecified() {
			return false, "", errors.New("unsupported loopback address")
		}
		family = ipv4Loopback
	case !address.Is4In6():
		family = ipv6Loopback
	default:
		return false, "", errors.New("IPv4-mapped URL addresses are unsupported")
	}
	local = true

	return local, family, nil
}

func rewriteLocalURL(u *url.URL, family string, port int, mappings []Mapping) (string, error) {
	families := []string{family}
	if family == "" {
		families = []string{ipv4Loopback, ipv6Loopback}
	}
	for _, f := range families {
		for _, m := range mappings {
			if m.Guest == (Endpoint{f, port}) && m.Available {
				ep, parseEndpointErr := ParseEndpoint(m.Local)
				if parseEndpointErr != nil {
					return "", errors.New("invalid local mapping")
				}
				u.Host = ep.Address()
				return u.String(), nil
			}
		}
	}
	return "", fmt.Errorf("no available forward for guest port %d", port)
}

const (
	maxDiscoveryLineBytes = 64 * 1024
)

const initialScanBufferBytes = 4096
