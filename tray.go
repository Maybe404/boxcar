package main

import (
	_ "embed"
	"fmt"
	"log"
	"strings"

	"github.com/egoist/mygo"
	sblog "github.com/sagernet/sing-box/log"
)

//go:embed resources/tray.png
var trayIcon []byte

// tray is the icon in the menu bar: the rates while running, and a menu
// to start and stop, switch the mode and the nodes, and open the window.
type tray struct {
	box  *Box
	icon *mygo.Tray
	// menuKey is what the menu shows, to build it again only on changes.
	menuKey string
	title   string
}

func newTray(b *Box) *tray {
	t := &tray{box: b}
	icon, err := mygo.NewTray(mygo.TrayOptions{Icon: trayIcon, IconIsTemplate: true, ToolTip: appName})
	if err != nil {
		log.Println("tray:", err)
		b.note(sblog.LevelError, "没能创建菜单栏图标：%v", err)
		return t
	}
	t.icon = icon
	t.update(b.State())
	return t
}

// run follows the state; call it on its own goroutine.
func (t *tray) update(s Snapshot) {
	if t.icon == nil {
		return
	}
	title := ""
	if s.Status == StatusRunning {
		title = "↓" + shortRate(s.Stats.DownloadRate) + " ↑" + shortRate(s.Stats.UploadRate)
	}
	if title != t.title {
		t.title = title
		t.icon.SetTitle(title)
	}
	var groups []OutboundGroup
	if s.Status == StatusRunning {
		groups = t.box.Groups()
	}
	key := menuKey(s, groups)
	if key == t.menuKey {
		return
	}
	t.menuKey = key
	t.icon.SetMenu(t.menu(s, groups))
}

func menuKey(s Snapshot, groups []OutboundGroup) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s|%s|%s|%v|%v|", s.Status, s.Profile, s.Mode.Current, s.SystemProxy.Enabled, s.SystemProxy.Active)
	for _, g := range groups {
		fmt.Fprintf(&b, "%s=%s;", g.Tag, g.Selected)
		for _, it := range g.Items {
			b.WriteString(it.Tag)
			b.WriteByte(',')
		}
	}
	return b.String()
}

func (t *tray) menu(s Snapshot, groups []OutboundGroup) *mygo.Menu {
	b := t.box
	// The items run on the main thread: calls that may block go apart.
	async := func(fn func() error) func(*mygo.MenuItem, *mygo.Window) {
		return func(*mygo.MenuItem, *mygo.Window) {
			go func() {
				if err := fn(); err != nil {
					mygo.Dialog.Error(appName, err.Error())
				}
			}()
		}
	}
	status := map[Status]string{StatusStopped: "未运行", StatusStarting: "正在启动…", StatusRunning: "运行中", StatusStopping: "正在停止…"}[s.Status]
	header := "内核" + status
	if s.Profile != "" {
		header += " · " + s.Profile
	}
	items := []*mygo.MenuItem{{Label: header, Disabled: true}}
	switch s.Status {
	case StatusStopped:
		// Starting from the menu asks nothing; a configuration that takes
		// over the network is started from the window, which asks first.
		takeover := len(b.Takeover()) > 0
		items = append(items, &mygo.MenuItem{Label: "启动", Disabled: s.Profile == "" || takeover, ToolTip: "会接管系统网络的配置请在窗口中启动", Click: async(b.Start)})
	case StatusRunning:
		items = append(items, &mygo.MenuItem{Label: "停止", Click: async(b.Stop)})
	}
	if s.Status == StatusRunning && len(s.Mode.List) > 0 {
		var modes []*mygo.MenuItem
		for _, m := range s.Mode.List {
			mode := m
			modes = append(modes, &mygo.MenuItem{Label: modeLabel(mode), Type: mygo.MenuItemRadio, Checked: strings.EqualFold(mode, s.Mode.Current), Click: async(func() error { return b.SetMode(mode) })})
		}
		items = append(items, mygo.Separator(), &mygo.MenuItem{Label: "模式：" + modeLabel(s.Mode.Current), Submenu: modes})
	}
	var groupItems []*mygo.MenuItem
	for _, g := range groups {
		if !g.Selectable {
			continue
		}
		var sub []*mygo.MenuItem
		for _, it := range g.Items {
			group, tag := g.Tag, it.Tag
			label := tag
			if it.Delay > 0 {
				label += fmt.Sprintf("  %d ms", it.Delay)
			}
			sub = append(sub, &mygo.MenuItem{Label: label, Type: mygo.MenuItemRadio, Checked: tag == g.Selected, Click: async(func() error { return b.Select(group, tag) })})
		}
		groupItems = append(groupItems, &mygo.MenuItem{Label: g.Tag + "：" + g.Selected, Submenu: sub})
	}
	if len(groupItems) > 0 {
		items = append(items, mygo.Separator())
		items = append(items, groupItems...)
	}
	if s.Status == StatusRunning {
		items = append(items, mygo.Separator(),
			&mygo.MenuItem{Label: "关闭全部连接", Click: async(func() error { b.CloseAllConnections(); return nil })},
		)
	}
	items = append(items, mygo.Separator(),
		&mygo.MenuItem{Label: "设为系统代理", Type: mygo.MenuItemCheckbox, Checked: s.SystemProxy.Enabled, Click: async(func() error { return b.SetSystemProxy(!s.SystemProxy.Enabled) })},
		mygo.Separator(),
		&mygo.MenuItem{Label: "打开 Boxcar", Click: func(*mygo.MenuItem, *mygo.Window) { showWindow() }},
		&mygo.MenuItem{Label: "退出", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Quit() }},
	)
	return mygo.NewMenu(items)
}

// modeLabel names the Clash modes sing-box has built in.
func modeLabel(mode string) string {
	switch strings.ToLower(mode) {
	case "rule":
		return "规则"
	case "global":
		return "全局"
	case "direct":
		return "直连"
	}
	return mode
}

// shortRate formats a rate for the menu bar, as 1.2M or 860K.
func shortRate(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1fM", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%dK", n>>10)
	default:
		return fmt.Sprintf("%dB", n)
	}
}
