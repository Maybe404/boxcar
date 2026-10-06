//go:build !darwin

package main

// workspaceIcon has no Finder to ask outside macOS.
func workspaceIcon(string) []byte { return nil }
