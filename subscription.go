package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	req.Header.Set("User-Agent", fmt.Sprintf("Boxcar/%s (sing-box %s; %s)", appVersion(), C.Version, strings.TrimSpace(osName())))
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
