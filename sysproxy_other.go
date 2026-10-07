//go:build !darwin && !windows

package main

import (
	"errors"
	"net/http"
	"net/url"
)

// Other platforms have no system proxy the app knows how to set.

type proxySnapshot struct{}

func (s *proxySnapshot) valid() bool { return false }

var errNoSystemProxy = errors.New("这个平台还不支持设置系统代理")

func takeSnapshot() (*proxySnapshot, error)               { return nil, errNoSystemProxy }
func applyProxy(*proxySnapshot, string, int, bool) error  { return errNoSystemProxy }
func restoreProxy(*proxySnapshot) error                   { return nil }
func currentProxy() string                                { return "" }
func systemHTTPProxy(req *http.Request) (*url.URL, error) { return http.ProxyFromEnvironment(req) }
