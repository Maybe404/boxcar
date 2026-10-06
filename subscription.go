package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"time"

	C "github.com/sagernet/sing-box/constant"
)

// Remote is where a profile comes from when it is a subscription.
type Remote struct {
	URL        string `json:"url"`
	AutoUpdate bool   `json:"autoUpdate"`
	// Interval is the minutes between automatic updates, at least 15.
	Interval  int       `json:"interval"`
	UpdatedAt time.Time `json:"updatedAt,omitzero"`
	// Error is why the last update failed, empty after a success.
	Error string `json:"error,omitempty"`
	// Conflicts are the places the last update and the user both changed,
	// where the user's change was kept.
	Conflicts []string `json:"conflicts,omitempty"`
}

const (
	defaultInterval = 60
	minInterval     = 15
	maxProfileSize  = 32 << 20
)

func normalizeRemote(r *Remote) {
	if r.Interval == 0 {
		r.Interval = defaultInterval
	}
	r.Interval = max(r.Interval, minInterval)
}

// fetchProfile downloads a configuration. The request is the app's own,
// outside sing-box, as the official clients make it: it goes through the
// system's HTTP proxy, which Surge sets, rather than around it.
func fetchProfile(ctx context.Context, link string) ([]byte, error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("订阅地址必须是 http:// 或 https:// 开头的网址")
	}
	client := &http.Client{
		Timeout:   60 * time.Second,
		Transport: &http.Transport{Proxy: systemHTTPProxy},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	// Some providers answer with sing-box configurations for this.
	req.Header.Set("User-Agent", fmt.Sprintf("Boxcar/%s (sing-box %s; macOS)", appVersion(), C.Version))
	resp, err := client.Do(req)
	if err != nil {
		// Without the address, which may carry the subscription's token:
		// the error goes into the log, which people copy to ask for help.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("下载失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载失败：服务器返回 %s", resp.Status)
	}
	content, err := io.ReadAll(io.LimitReader(resp.Body, maxProfileSize+1))
	if err != nil {
		return nil, fmt.Errorf("下载失败：%w", err)
	}
	if len(content) > maxProfileSize {
		return nil, errors.New("下载的文件超过 32 MB，不像是配置文件")
	}
	return content, nil
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
