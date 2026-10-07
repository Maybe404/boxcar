//go:build darwin

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// iconKey is the outermost app bundle a program is in.
func iconKey(path string) string { return bundleOf(path) }

// iconStamp is when the bundle's Info.plist changed, which an update
// rewrites; false when the app is gone.
func iconStamp(bundle string) (time.Time, bool) {
	info, err := os.Stat(filepath.Join(bundle, "Contents", "Info.plist"))
	if err != nil {
		return time.Time{}, false
	}
	return info.ModTime(), true
}

// drawIcon converts the bundle's .icns with sips, or asks AppKit for the
// icon Finder shows, when it is only in the asset catalog.
func drawIcon(bundle, tmp string) []byte {
	icns := iconFile(bundle)
	if icns == "" {
		return workspaceIcon(bundle)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tmp += ".png"
	defer os.Remove(tmp)
	if err := exec.CommandContext(ctx, "/usr/bin/sips", "-s", "format", "png", "-Z", "64", icns, "--out", tmp).Run(); err != nil {
		return nil
	}
	data, err := os.ReadFile(tmp)
	if err != nil {
		return nil
	}
	return data
}

// iconFile finds the .icns of a bundle, as its Info.plist names it.
func iconFile(bundle string) string {
	resources := filepath.Join(bundle, "Contents", "Resources")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/plutil", "-extract", "CFBundleIconFile", "raw", "-o", "-", filepath.Join(bundle, "Contents", "Info.plist")).Output()
	if name := strings.TrimSpace(string(out)); err == nil && name != "" {
		if !strings.HasSuffix(name, ".icns") {
			name += ".icns"
		}
		if path := filepath.Join(resources, filepath.Base(name)); fileExists(path) {
			return path
		}
	}
	// Apps whose plist names an asset catalog often still ship this.
	if path := filepath.Join(resources, "AppIcon.icns"); fileExists(path) {
		return path
	}
	return ""
}

// appKit loads AppKit, which the app has loaded already; a test has not.
var appKit = sync.OnceValue(func() bool {
	_, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_GLOBAL|purego.RTLD_LAZY)
	return err == nil
})

// appKitCalls makes one call into AppKit at a time.
var appKitCalls sync.Mutex

// workspaceIcon returns the icon Finder shows for a file, as a PNG about
// 64 points wide: for an app whose icon is only in its asset catalog,
// which sips cannot read. Only the size asked is drawn, not every size
// the icon has, which together are tens of megabytes.
func workspaceIcon(path string) []byte {
	if !appKit() {
		return nil
	}
	appKitCalls.Lock()
	defer appKitCalls.Unlock()
	// The autorelease pool belongs to the thread: made and drained on the
	// same one, or the app crashes.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	sel := objc.RegisterName
	pool := objc.ID(objc.GetClass("NSAutoreleasePool")).Send(sel("new"))
	defer pool.Send(sel("drain"))
	cpath := append([]byte(path), 0)
	nsPath := objc.ID(objc.GetClass("NSString")).Send(sel("stringWithUTF8String:"), &cpath[0])
	runtime.KeepAlive(cpath)
	image := objc.ID(objc.GetClass("NSWorkspace")).Send(sel("sharedWorkspace")).Send(sel("iconForFile:"), nsPath)
	if image == 0 {
		return nil
	}
	// The image of the size asked: x, y, width, height, in points.
	rect := [4]float64{0, 0, 64, 64}
	cg := image.Send(sel("CGImageForProposedRect:context:hints:"), &rect, objc.ID(0), objc.ID(0))
	runtime.KeepAlive(&rect)
	if cg == 0 {
		return nil
	}
	rep := objc.ID(objc.GetClass("NSBitmapImageRep")).Send(sel("alloc")).Send(sel("initWithCGImage:"), cg)
	if rep == 0 {
		return nil
	}
	defer rep.Send(sel("release"))
	const pngType = 4 // NSBitmapImageFileTypePNG
	props := objc.ID(objc.GetClass("NSDictionary")).Send(sel("dictionary"))
	data := rep.Send(sel("representationUsingType:properties:"), uint(pngType), props)
	if data == 0 {
		return nil
	}
	n := objc.Send[uint](data, sel("length"))
	p := objc.Send[unsafe.Pointer](data, sel("bytes"))
	if n == 0 || p == nil {
		return nil
	}
	return append([]byte(nil), unsafe.Slice((*byte)(p), n)...)
}
