package main

import "testing"

func TestBundleOf(t *testing.T) {
	for path, want := range map[string]string{
		"/Applications/Dia.app/Contents/MacOS/Dia":                                           "/Applications/Dia.app",
		"/Applications/Dia.app/Contents/Frameworks/Dia Helper.app/Contents/MacOS/Dia Helper": "/Applications/Dia.app",
		"/usr/bin/curl": "",
	} {
		if got := bundleOf(path); got != want {
			t.Errorf("%s: %q, want %q", path, got, want)
		}
	}
}
