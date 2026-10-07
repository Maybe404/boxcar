package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// On Windows the system proxy is the user's Internet settings in the
// registry, which browsers and most apps read; a change takes effect once
// announced with InternetSetOption.

const internetSettings = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`

// proxySnapshot is what the Internet settings were before the app set
// them, each value with whether it was there, to put back as it was.
type proxySnapshot struct {
	Taken         bool   `json:"taken"`
	Enable        uint32 `json:"enable"`
	HasEnable     bool   `json:"hasEnable"`
	Server        string `json:"server"`
	HasServer     bool   `json:"hasServer"`
	Override      string `json:"override"`
	HasOverride   bool   `json:"hasOverride"`
	AutoConfig    string `json:"autoConfig"`
	HasAutoConfig bool   `json:"hasAutoConfig"`
}

func (s *proxySnapshot) valid() bool { return s.Taken }

func takeSnapshot() (*proxySnapshot, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, internetSettings, registry.QUERY_VALUE)
	if err != nil {
		return nil, fmt.Errorf("读取系统代理失败：%w", err)
	}
	defer k.Close()
	snap := &proxySnapshot{Taken: true}
	if v, _, err := k.GetIntegerValue("ProxyEnable"); err == nil {
		snap.Enable, snap.HasEnable = uint32(v), true
	}
	snap.Server, snap.HasServer = stringValue(k, "ProxyServer")
	snap.Override, snap.HasOverride = stringValue(k, "ProxyOverride")
	snap.AutoConfig, snap.HasAutoConfig = stringValue(k, "AutoConfigURL")
	return snap, nil
}

func stringValue(k registry.Key, name string) (string, bool) {
	v, _, err := k.GetStringValue(name)
	return v, err == nil
}

// localOverride is what goes around the proxy when nothing was set: this
// computer and the local network.
const localOverride = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>"

// applyProxy points the Internet settings at host:port. Windows sends
// HTTP, HTTPS and FTP to one proxy given as host:port; SOCKS clients read
// their own settings, so socks changes nothing here. A proxy
// auto-configuration script would come first, so it goes until restored.
func applyProxy(snap *proxySnapshot, host string, port int, socks bool) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, internetSettings, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("设置系统代理失败：%w", err)
	}
	defer k.Close()
	override := snap.Override
	if !snap.HasOverride || override == "" {
		override = localOverride
	}
	err = errors.Join(
		k.SetStringValue("ProxyServer", fmt.Sprintf("%s:%d", host, port)),
		k.SetStringValue("ProxyOverride", override),
		k.SetDWordValue("ProxyEnable", 1),
	)
	if snap.HasAutoConfig {
		err = errors.Join(err, deleteValue(k, "AutoConfigURL"))
	}
	return errors.Join(err, announce())
}

func restoreProxy(snap *proxySnapshot) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, internetSettings, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("恢复系统代理失败：%w", err)
	}
	defer k.Close()
	put := func(name, value string, had bool) error {
		if had {
			return k.SetStringValue(name, value)
		}
		return deleteValue(k, name)
	}
	enable := deleteValue(k, "ProxyEnable")
	if snap.HasEnable {
		enable = k.SetDWordValue("ProxyEnable", snap.Enable)
	}
	err = errors.Join(
		put("ProxyServer", snap.Server, snap.HasServer),
		put("ProxyOverride", snap.Override, snap.HasOverride),
		put("AutoConfigURL", snap.AutoConfig, snap.HasAutoConfig),
		enable,
	)
	return errors.Join(err, announce())
}

// deleteValue removes a value, which may not be there.
func deleteValue(k registry.Key, name string) error {
	if err := k.DeleteValue(name); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

var (
	wininet           = windows.NewLazySystemDLL("wininet.dll")
	internetSetOption = wininet.NewProc("InternetSetOptionW")
)

// announce tells the apps running that the Internet settings changed.
func announce() error {
	const (
		settingsChanged = 39 // INTERNET_OPTION_SETTINGS_CHANGED
		refresh         = 37 // INTERNET_OPTION_REFRESH
	)
	if err := internetSetOption.Find(); err != nil {
		return err
	}
	// Both, whatever the first did: the second makes them read it again.
	var failed error
	for _, option := range []uintptr{settingsChanged, refresh} {
		if ok, _, err := internetSetOption.Call(0, option, 0, 0); ok == 0 && failed == nil {
			failed = fmt.Errorf("通知系统代理变化失败（%d）：%w", option, err)
		}
	}
	return failed
}

// currentProxy describes the system's proxy now, as "127.0.0.1:6152".
func currentProxy() string {
	snap, err := takeSnapshot()
	if err != nil {
		return ""
	}
	switch {
	case snap.HasAutoConfig && snap.AutoConfig != "":
		return "自动配置脚本 " + snap.AutoConfig
	case snap.Enable == 0 || snap.Server == "":
		return "未设置"
	}
	return snap.Server
}

// systemHTTPProxy returns the system's proxy for a request, as the
// Internet settings give it: Go's own lookup reads only environment
// variables. A proxy auto-configuration script is not run.
func systemHTTPProxy(req *http.Request) (*url.URL, error) {
	snap, err := takeSnapshot()
	if err != nil || snap.Enable == 0 || snap.Server == "" {
		return nil, nil
	}
	return proxyFor(snap.Server, req.URL.Scheme), nil
}
