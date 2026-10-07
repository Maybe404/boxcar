package main

import "testing"

func TestWindowsProxySetting(t *testing.T) {
	for _, c := range []struct{ server, scheme, want string }{
		{"127.0.0.1:6152", "https", "http://127.0.0.1:6152"},
		{"http=127.0.0.1:8080;https=127.0.0.1:8443", "https", "http://127.0.0.1:8443"},
		{"http=127.0.0.1:8080; socks=127.0.0.1:1080", "https", "socks5://127.0.0.1:1080"},
		{"ftp=127.0.0.1:21", "https", ""},
	} {
		got := ""
		if u := proxyFor(c.server, c.scheme); u != nil {
			got = u.String()
		}
		if got != c.want {
			t.Errorf("%q %s: %q, want %q", c.server, c.scheme, got, c.want)
		}
	}
}
