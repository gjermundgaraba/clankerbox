package client

import (
	"reflect"
	"strings"
	"testing"
)

func TestDiscoveryParsers(t *testing.T) {
	want := []Endpoint{{"127.0.0.1", 3000}, {"127.0.0.1", 4000}, {"::1", 3000}, {"::1", 5000}}
	cases := []struct{ os, input string }{
		{"linux", `LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*
LISTEN 0 10 127.0.0.1:4000 0.0.0.0:*
LISTEN 0 10 [::]:3000 [::]:*
LISTEN 0 10 [::1]:5000 [::]:*
LISTEN 0 10 127.0.0.1:4000 0.0.0.0:*
LISTEN 0 10 192.168.1.2:8888 0.0.0.0:*
LISTEN 0 10 0.0.0.0:22 0.0.0.0:*
LISTEN 0 10 0.0.0.0:443 0.0.0.0:*
LISTEN 0 10 [::]:5900 [::]:*
ESTAB 0 0 127.0.0.1:7777 0.0.0.0:*
`},
		{"macos", `p42
n*:3000
n127.0.0.1:4000
n[::1]:5000
n127.0.0.1:4000
n192.168.1.2:8888
n*:22
n*:443
n*:5900
`},
	}
	for _, c := range cases {
		t.Run(c.os, func(t *testing.T) {
			got, e := ParseListeners(c.os, c.input)
			if e != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("got %#v, %v", got, e)
			}
		})
	}
}
func TestDiscoveryRejectsUntrustedDestinations(t *testing.T) {
	bad := []string{"localhost:3000", "evil.example:3000", "10.0.0.1:3000", "169.254.169.254:3000", "[fe80::1%en0]:3000", "[::ffff:127.0.0.1]:3000", "[::ffff:0.0.0.0]:3000", "127.0.0.2:3000", "[127.0.0.1]]:3000", "[[::1]:3000", "127.0.0.1:+3000", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:3000;id", "127.0.0.1:3000->10.0.0.1:1234", "*:22", "*:5900", "*:1023"}
	for _, s := range bad {
		if got := discoveryEndpoint(s); len(got) != 0 {
			t.Errorf("accepted %q: %v", s, got)
		}
	}
	if _, e := ParseListeners("windows", ""); e == nil {
		t.Fatal("unknown OS accepted")
	}
	if _, e := ParseListeners("linux", strings.Repeat("x", 70000)); e == nil {
		t.Fatal("unbounded line accepted")
	}
	for _, s := range []string{"localhost:3000", "0.0.0.0:3000", "127.0.0.2:3000", "[::]:3000", "[::1%lo]:3000", "[::ffff:127.0.0.1]:3000", "127.0.0.1:-1", "127.0.0.1:65536"} {
		if _, e := ParseEndpoint(s); e == nil {
			t.Errorf("explicit destination accepted %q", s)
		}
	}
	for _, s := range []string{"127.0.0.1:22", "127.0.0.1:5900", "[::1]:65535"} {
		if _, e := ParseEndpoint(s); e != nil {
			t.Errorf("explicit destination rejected %q", s)
		}
	}
}
func TestRewriteURL(t *testing.T) {
	mappings := []Mapping{{Guest: Endpoint{"127.0.0.1", 3000}, Local: "127.0.0.1:43123", Available: true}, {Guest: Endpoint{"::1", 3000}, Local: "[::1]:43124", Available: true}, {Guest: Endpoint{"127.0.0.1", 443}, Local: "127.0.0.1:43125", Available: true}}
	for _, c := range []struct {
		in, want string
		external bool
	}{
		{"http://localhost:3000/a%2Fb?q=x%20y#frag", "http://127.0.0.1:43123/a%2Fb?q=x%20y#frag", false},
		{"http://0.0.0.0:3000/path?", "http://127.0.0.1:43123/path?", false},
		{"http://[::]:3000/", "http://[::1]:43124/", false},
		{"http://[::1]:3000/", "http://[::1]:43124/", false},
		{"https://localhost/", "https://127.0.0.1:43125/", false},
		{"https://example.com/a?q=b#c", "https://example.com/a?q=b#c", true},
	} {
		out, e := RewriteURL(c.in, mappings, c.external)
		if e != nil || out != c.want {
			t.Errorf("%s => %q %v", c.in, out, e)
		}
	}
	for _, raw := range []string{"http://localhost:3001/", "http://127.0.0.2:3000/", "http://[::ffff:127.0.0.1]:3000/", "http://[::1%25lo]:3000/", "http://example.com:3000/", "http://localhost:/", "http://localhost:0/", "http://localhost:65536/", "http://localhost:-1/", "http://localhost:wat/", "ftp://localhost:3000/", "javascript:alert(1)", "http:///x", "//localhost:3000", "http://user:password@localhost:3000/", "http://localhost:3000/\n"} {
		if out, e := RewriteURL(raw, mappings, false); e == nil {
			t.Errorf("accepted %q => %s", raw, out)
		}
	}
	mappings[0].Available = false
	if _, e := RewriteURL("http://127.0.0.1:3000/", mappings, false); e == nil {
		t.Fatal("unavailable mapping accepted")
	}
	if out, e := RewriteURL("http://localhost:3000/", mappings, false); e != nil || out != "http://[::1]:43124/" {
		t.Fatalf("IPv6 fallback %s %v", out, e)
	}
	mappings[1].Local = "192.168.1.1:3000"
	if _, e := RewriteURL("http://[::1]:3000/", mappings, false); e == nil {
		t.Fatal("unsafe mapping accepted")
	}
}

func TestOpenURLRejectsBrowserNumericAliases(t *testing.T) {
	for _, raw := range []string{"http://127.1:3000/", "http://2130706433:3000/", "http://0177.0.0.1:3000/", "http://0x7f.0.0.1:3000/", "http://[localhost]:3000/", "http://[bad-host]:3000/"} {
		if result, e := RewriteURL(raw, nil, true); e == nil {
			t.Errorf("external bypass %q => %q", raw, result)
		}
	}
	for _, raw := range []string{"http://localhost.:3000/", "http://127.0.0.1.:3000/"} {
		if _, e := RewriteURL(raw, nil, true); e == nil {
			t.Errorf("unmapped local URL accepted %s", raw)
		}
	}
}
