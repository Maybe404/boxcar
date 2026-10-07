package main

import (
	"bufio"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
)

// On macOS the system proxy is a setting of each network service, which
// networksetup reads and writes; the primary service is the one of the
// default route.

// proxyState is one kind of proxy of a network service, as networksetup
// reports it.
type proxyState struct {
	Enabled bool   `json:"enabled"`
	Server  string `json:"server"`
	Port    int    `json:"port"`
}

func (s proxyState) String() string {
	if !s.Enabled || s.Server == "" {
		return "未设置"
	}
	return s.Server + ":" + strconv.Itoa(s.Port)
}

// proxySnapshot is what the system proxy was before the app set it, to
// put back as it was: another app's, as Surge's, survives.
type proxySnapshot struct {
	Service string     `json:"service"`
	Web     proxyState `json:"web"`
	Secure  proxyState `json:"secure"`
	SOCKS   proxyState `json:"socks"`
}

func (s *proxySnapshot) valid() bool { return s.Service != "" }

func takeSnapshot() (*proxySnapshot, error) {
	service, err := primaryService()
	if err != nil {
		return nil, err
	}
	snap := &proxySnapshot{Service: service}
	if snap.Web, err = getProxy("web", service); err != nil {
		return nil, err
	}
	if snap.Secure, err = getProxy("secureweb", service); err != nil {
		return nil, err
	}
	if snap.SOCKS, err = getProxy("socksfirewall", service); err != nil {
		return nil, err
	}
	return snap, nil
}

// applyProxy points HTTP and HTTPS at host:port, and SOCKS when the
// inbound speaks it.
func applyProxy(snap *proxySnapshot, host string, port int, socks bool) error {
	ours := proxyState{Enabled: true, Server: host, Port: port}
	err := errors.Join(setProxy("web", snap.Service, ours), setProxy("secureweb", snap.Service, ours))
	if socks {
		err = errors.Join(err, setProxy("socksfirewall", snap.Service, ours))
	}
	return err
}

func restoreProxy(snap *proxySnapshot) error {
	return errors.Join(
		setProxy("web", snap.Service, snap.Web),
		setProxy("secureweb", snap.Service, snap.Secure),
		setProxy("socksfirewall", snap.Service, snap.SOCKS),
	)
}

// currentProxy describes the system's HTTP proxy now, as "127.0.0.1:6152".
func currentProxy() string {
	service, err := primaryService()
	if err != nil {
		return ""
	}
	web, err := getProxy("web", service)
	if err != nil {
		return ""
	}
	return web.String()
}

// primaryService is the network service of the default route, as
// "Wi-Fi".
func primaryService() (string, error) {
	out, err := exec.Command("/sbin/route", "-n", "get", "default").Output()
	if err != nil {
		return "", fmt.Errorf("找不到默认网络：%w", err)
	}
	var device string
	for line := range strings.SplitSeq(string(out), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "interface:"); ok {
			device = strings.TrimSpace(v)
		}
	}
	if device == "" {
		return "", errors.New("找不到默认网络接口")
	}
	out, err = exec.Command("/usr/sbin/networksetup", "-listnetworkserviceorder").Output()
	if err != nil {
		return "", err
	}
	// "(1) Wi-Fi" followed by "(Hardware Port: Wi-Fi, Device: en0)".
	var name string
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "(Hardware Port:") {
			if strings.Contains(line, "Device: "+device+")") && name != "" {
				return name, nil
			}
			continue
		}
		if i := strings.Index(line, ") "); strings.HasPrefix(line, "(") && i > 0 {
			name = line[i+2:]
		}
	}
	return "", fmt.Errorf("找不到接口 %s 对应的网络服务", device)
}

// getProxy reads a kind of proxy ("web", "secureweb", "socksfirewall").
func getProxy(kind, service string) (proxyState, error) {
	out, err := exec.Command("/usr/sbin/networksetup", "-get"+kind+"proxy", service).Output()
	if err != nil {
		return proxyState{}, fmt.Errorf("读取系统代理失败：%w", err)
	}
	var s proxyState
	for line := range strings.SplitSeq(string(out), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		switch strings.TrimSpace(key) {
		case "Enabled":
			s.Enabled = value == "Yes"
		case "Server":
			s.Server = value
		case "Port":
			s.Port, _ = strconv.Atoi(value)
		}
	}
	return s, nil
}

// setProxy sets a kind of proxy, or turns it off.
func setProxy(kind, service string, s proxyState) error {
	var cmd *exec.Cmd
	if s.Enabled && s.Server != "" {
		cmd = exec.Command("/usr/sbin/networksetup", "-set"+kind+"proxy", service, s.Server, strconv.Itoa(s.Port))
	} else {
		cmd = exec.Command("/usr/sbin/networksetup", "-set"+kind+"proxystate", service, "off")
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("设置系统代理失败：%s", strings.TrimSpace(string(out)+" "+err.Error()))
	}
	return nil
}

// systemHTTPProxy returns the system's proxy for a request, as scutil
// reports it: Go's own lookup reads only environment variables.
func systemHTTPProxy(req *http.Request) (*url.URL, error) {
	out, err := exec.Command("/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return nil, nil
	}
	values := map[string]string{}
	for line := range strings.SplitSeq(string(out), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	prefix := "HTTP"
	if req.URL.Scheme == "https" {
		prefix = "HTTPS"
	}
	if values[prefix+"Enable"] != "1" || values[prefix+"Proxy"] == "" {
		if values["SOCKSEnable"] == "1" && values["SOCKSProxy"] != "" {
			return &url.URL{Scheme: "socks5", Host: values["SOCKSProxy"] + ":" + values["SOCKSPort"]}, nil
		}
		return nil, nil
	}
	port, _ := strconv.Atoi(values[prefix+"Port"])
	if port == 0 {
		port = 80
	}
	return &url.URL{Scheme: "http", Host: values[prefix+"Proxy"] + ":" + strconv.Itoa(port)}, nil
}
