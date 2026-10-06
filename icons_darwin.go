//go:build darwin

package main

import (
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

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
