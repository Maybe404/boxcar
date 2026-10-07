// The defaults sing-box's release builds set with -X runtime.godebugDefault.

//go:debug multipathtcp=0
//go:debug tlssha1=1

// Boxcar is a macOS and Windows app that runs the sing-box core inside itself, and
// starts it only when the user clicks Start. Its window shows the
// frontend in frontend/, which calls the Box service.
package main

import (
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/egoist/mygo"
	C "github.com/sagernet/sing-box/constant"
	sblog "github.com/sagernet/sing-box/log"
)

// coreVersion is the version of sing-box the app is built from, which
// build.sh writes into version_gen.go.
var coreVersion string

const appName = "Boxcar"

var (
	winMu sync.Mutex
	win   *mygo.Window
)

func main() {
	if coreVersion != "" {
		C.Version = coreVersion
	}
	mygo.App.SetName(appName)
	if !mygo.App.RequestSingleInstanceLock() {
		return // the running instance shows its window
	}
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		log.Fatal(err)
	}
	st, err := openStore(dir)
	if err != nil {
		log.Fatal(err)
	}
	// Relative paths of configurations, as a cache file's, are in the
	// working directory.
	os.Chdir(st.workDir())
	trash = mygo.Shell.TrashItem

	// A system proxy a previous run left set goes back as it was.
	proxy := newSystemProxy(filepath.Join(dir, "system-proxy.json"))
	recovered, recoverErr := proxy.recover()
	if recoverErr != nil {
		log.Println("restore the system proxy:", recoverErr)
	}

	var box *Box
	core := newBoxCore(func() { box.changed() })
	box = newBox(core, st, proxy)
	core.Logs().onAppend = box.logged
	switch {
	case recoverErr != nil:
		box.note(sblog.LevelError, "上次退出时没能恢复系统代理，这次也没能恢复：%v", recoverErr)
	case recovered:
		box.note(sblog.LevelWarn, "上次退出时没能恢复系统代理，已恢复为原来的设置")
	}
	mygo.Bind(box)
	go box.broadcast()
	go box.broadcastLogs()

	applyTheme(st.settings().Theme)
	mygo.App.OnSecondInstance(func([]string, string) { showWindow() })
	mygo.App.OnActivate(func(hasVisibleWindows bool) {
		if !hasVisibleWindows {
			showWindow()
		}
	})
	// Closing the window keeps the app in the menu bar; quitting it puts
	// the system proxy back and stops the core, whatever it is doing,
	// before the app goes.
	mygo.App.OnWindowAllClosed(func() {})
	var quitting atomic.Bool
	mygo.App.OnWillQuit(func(e *mygo.QuitEvent) {
		if quitting.Load() {
			return
		}
		active, _ := proxy.active()
		if core.Status() == statusStopped && !active {
			return
		}
		e.PreventDefault()
		quitting.Store(true)
		go func() {
			box.shutdown()
			mygo.App.Quit()
		}()
	})
	// Shutting down, logging out or a forced restart ends the app without
	// asking first, past OnWillQuit: the system proxy still goes back, or
	// it would point at a port nothing listens on until the app opens.
	mygo.App.OnQuit(func() { proxy.disable() })
	mygo.App.WhenReady(func() {
		mygo.App.SetMenu(buildMenu())
		t := newTray(box)
		update := t.update
		box.onState.Store(&update)
		box.changed()
		go box.updateLoop()
		showWindow()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// showWindow shows the window, or opens it again once closed.
func showWindow() {
	winMu.Lock()
	defer winMu.Unlock()
	if win != nil && !win.IsDestroyed() {
		win.Show()
		win.Focus()
		return
	}
	opts := mygo.WindowOptions{
		Title:          appName,
		Width:          1120,
		Height:         740,
		MinWidth:       880,
		MinHeight:      580,
		StateKey:       "main",
		TitleBarStyle:  mygo.TitleBarHiddenInset,
		TitleBarHeight: 52,
		// The sidebar's material shows where the page is transparent.
		Vibrancy:        mygo.VibrancySidebar,
		BackgroundColor: "light-dark(#ececec, #262626)",
		URL:             "/",
	}
	if runtime.GOOS == "windows" {
		// The window buttons at the top right, over the page's title bar,
		// and Mica behind the sidebar (Windows 11).
		opts.TitleBarStyle, opts.TitleBarHeight, opts.Vibrancy = mygo.TitleBarHidden, 40, mygo.VibrancyMica
		opts.BackgroundColor = "light-dark(#f3f3f3, #202020)"
	}
	win = mygo.NewWindow(opts)
	// The page is the app's own and goes nowhere else: no new windows, no
	// navigation away, so nothing loads from the network.
	win.Page().SetWindowOpenHandler(func(mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
	win.Page().OnWillNavigate(func(e *mygo.NavigateEvent) {
		if !strings.HasPrefix(e.URL, "mygo://") && !strings.HasPrefix(e.URL, "http://localhost:") {
			e.PreventDefault()
		}
	})
}

// Navigate sends a command of the menu to the page: a page to show, or
// "import".
var Navigate = mygo.NewEvent[string]("navigate")

// editMenu is the edit menu on macOS, where the page's text fields need
// it for copy and paste. On Windows WebView2 handles those keys itself,
// and a menu taking them would undo through the browser rather than the
// JSON editor's own history.
func editMenu() *mygo.MenuItem {
	if runtime.GOOS == "darwin" {
		return &mygo.MenuItem{Role: mygo.RoleEditMenu}
	}
	return &mygo.MenuItem{Role: mygo.RoleEditMenu, Hidden: true}
}

func buildMenu() *mygo.Menu {
	page := func(path string) func(*mygo.MenuItem, *mygo.Window) {
		return func(_ *mygo.MenuItem, w *mygo.Window) {
			if w != nil {
				Navigate.Emit(w, path)
			}
		}
	}
	file := []*mygo.MenuItem{
		{Label: "导入配置…", Accelerator: "CmdOrCtrl+O", Click: page("import")},
		mygo.Separator(),
		{Role: mygo.RoleClose},
	}
	// The menu named after the app is macOS's, and left out elsewhere:
	// its settings and quitting go in the file menu.
	if runtime.GOOS != "darwin" {
		file = append(file[:1],
			mygo.Separator(),
			&mygo.MenuItem{Label: "设置…", Accelerator: "CmdOrCtrl+,", Click: page("settings")},
			mygo.Separator(),
			&mygo.MenuItem{Role: mygo.RoleClose},
			&mygo.MenuItem{Role: mygo.RoleQuit},
		)
	}
	return mygo.NewMenu([]*mygo.MenuItem{
		{Role: mygo.RoleAppMenu, Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleAbout},
			mygo.Separator(),
			{Label: "设置…", Accelerator: "CmdOrCtrl+,", Click: page("settings")},
			mygo.Separator(),
			{Role: mygo.RoleServices},
			mygo.Separator(),
			{Role: mygo.RoleHide},
			{Role: mygo.RoleHideOthers},
			{Role: mygo.RoleUnhide},
			mygo.Separator(),
			{Role: mygo.RoleQuit},
		}},
		{Label: "文件", Submenu: file},
		editMenu(),
		{Label: "显示", Submenu: []*mygo.MenuItem{
			{Label: "线路", Accelerator: "CmdOrCtrl+1", Click: page("line")},
			{Label: "节点", Accelerator: "CmdOrCtrl+2", Click: page("nodes")},
			{Label: "连接", Accelerator: "CmdOrCtrl+3", Click: page("connections")},
			{Label: "日志", Accelerator: "CmdOrCtrl+4", Click: page("logs")},
			{Label: "配置", Accelerator: "CmdOrCtrl+5", Click: page("profiles")},
			mygo.Separator(),
			{Role: mygo.RoleToggleFullScreen},
		}},
		{Role: mygo.RoleWindowMenu},
	})
}
