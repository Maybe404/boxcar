package main

import (
	"bufio"
	stdjson "encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

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

// systemProxy points the system proxy of the primary network service at
// sing-box, and restores what it was. sing-box's own system proxy turns
// the proxy off when it stops, which would drop another app's; this one
// puts the previous settings back.
type systemProxy struct {
	mu   sync.Mutex
	path string // where the snapshot is kept while set, to restore after a crash
	snap *proxySnapshot
	// address is where the proxy points while set.
	address string
}

func newSystemProxy(path string) *systemProxy {
	return &systemProxy{path: path}
}

// recover restores the proxy that a previous run of the app left set,
// when it did not get to.
func (p *systemProxy) recover() error {
	data, err := os.ReadFile(p.path)
	if err != nil {
		return nil
	}
	var snap proxySnapshot
	if stdjson.Unmarshal(data, &snap) != nil || snap.Service == "" {
		os.Remove(p.path)
		return nil
	}
	p.mu.Lock()
	p.snap = &snap
	p.mu.Unlock()
	return p.disable()
}

// active reports whether the app has set the system proxy, and where.
func (p *systemProxy) active() (bool, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.snap != nil, p.address
}

// enable points the system proxy at host:port, HTTP and HTTPS, and SOCKS
// when the inbound speaks it.
func (p *systemProxy) enable(host string, port int, socks bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.snap == nil {
		service, err := primaryService()
		if err != nil {
			return err
		}
		snap := &proxySnapshot{Service: service}
		if snap.Web, err = getProxy("web", service); err != nil {
			return err
		}
		if snap.Secure, err = getProxy("secureweb", service); err != nil {
			return err
		}
		if snap.SOCKS, err = getProxy("socksfirewall", service); err != nil {
			return err
		}
		data, _ := stdjson.MarshalIndent(snap, "", "  ")
		if err := os.WriteFile(p.path, data, 0o600); err != nil {
			return err
		}
		p.snap = snap
	}
	ours := proxyState{Enabled: true, Server: host, Port: port}
	err := errors.Join(setProxy("web", p.snap.Service, ours), setProxy("secureweb", p.snap.Service, ours))
	if socks {
		err = errors.Join(err, setProxy("socksfirewall", p.snap.Service, ours))
	}
	p.address = fmt.Sprintf("%s:%d", host, port)
	return err
}

// disable puts back the system proxy as it was.
func (p *systemProxy) disable() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.snap == nil {
		return nil
	}
	snap := p.snap
	err := errors.Join(
		setProxy("web", snap.Service, snap.Web),
		setProxy("secureweb", snap.Service, snap.Secure),
		setProxy("socksfirewall", snap.Service, snap.SOCKS),
	)
	if err == nil {
		os.Remove(p.path)
		p.snap, p.address = nil, ""
	}
	return err
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
