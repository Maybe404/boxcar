//go:build !darwin && !windows

package main

import "time"

// Other platforms show no app icons.

func iconKey(string) string              { return "" }
func iconStamp(string) (time.Time, bool) { return time.Time{}, false }
func drawIcon(string, string) []byte     { return nil }
