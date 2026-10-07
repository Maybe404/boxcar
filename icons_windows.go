package main

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// On Windows a program's icon is in its .exe: the shell extracts it at
// the size asked, and GDI hands over its pixels, which become a PNG.

// iconKey is the program itself, when it is an executable.
func iconKey(path string) string {
	// Not one on a network share, which the shell would reach for.
	if !strings.EqualFold(filepath.Ext(path), ".exe") || strings.HasPrefix(path, `\\`) {
		return ""
	}
	return path
}

// iconStamp is when the program changed; false when it is gone.
func iconStamp(path string) (time.Time, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}, false
	}
	return info.ModTime(), true
}

var (
	shell32            = windows.NewLazySystemDLL("shell32.dll")
	user32             = windows.NewLazySystemDLL("user32.dll")
	gdi32              = windows.NewLazySystemDLL("gdi32.dll")
	shDefExtractIconW  = shell32.NewProc("SHDefExtractIconW")
	getIconInfo        = user32.NewProc("GetIconInfo")
	destroyIcon        = user32.NewProc("DestroyIcon")
	getDC              = user32.NewProc("GetDC")
	releaseDC          = user32.NewProc("ReleaseDC")
	getObjectW         = gdi32.NewProc("GetObjectW")
	getDIBits          = gdi32.NewProc("GetDIBits")
	deleteObject       = gdi32.NewProc("DeleteObject")
	iconProcsAvailable = sync.OnceValue(func() bool {
		for _, p := range []*windows.LazyProc{shDefExtractIconW, getIconInfo, destroyIcon, getDC, releaseDC, getObjectW, getDIBits, deleteObject} {
			if p.Find() != nil {
				return false
			}
		}
		return true
	})
)

type iconInfo struct {
	fIcon    int32
	xHotspot uint32
	yHotspot uint32
	hbmMask  windows.Handle
	hbmColor windows.Handle
}

type bitmap struct {
	bmType       int32
	bmWidth      int32
	bmHeight     int32
	bmWidthBytes int32
	bmPlanes     uint16
	bmBitsPixel  uint16
	bmBits       uintptr
}

type bitmapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

// drawIcon extracts the program's first icon at 64 pixels.
func drawIcon(path, _ string) []byte {
	if !iconProcsAvailable() {
		return nil
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil
	}
	const size = 64
	var icon windows.Handle
	// The large icon at size×size, in the low word; no small one.
	hr, _, _ := shDefExtractIconW.Call(uintptr(unsafe.Pointer(name)), 0, 0, uintptr(unsafe.Pointer(&icon)), 0, size)
	if icon != 0 {
		defer destroyIcon.Call(uintptr(icon))
	}
	// A failure is a negative HRESULT; S_FALSE may come with an icon.
	if int32(hr) < 0 || icon == 0 {
		return nil
	}
	img := iconPixels(icon)
	if img == nil {
		return nil
	}
	var out bytes.Buffer
	if png.Encode(&out, img) != nil {
		return nil
	}
	return out.Bytes()
}

// iconPixels reads an icon's pixels: its color bitmap with its alpha, or
// with its mask for an old icon without alpha.
func iconPixels(icon windows.Handle) image.Image {
	var info iconInfo
	if ok, _, _ := getIconInfo.Call(uintptr(icon), uintptr(unsafe.Pointer(&info))); ok == 0 {
		return nil
	}
	defer deleteObject.Call(uintptr(info.hbmMask))
	if info.hbmColor == 0 {
		return nil
	}
	defer deleteObject.Call(uintptr(info.hbmColor))
	var bm bitmap
	if n, _, _ := getObjectW.Call(uintptr(info.hbmColor), unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm))); n == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 || bm.bmWidth > 512 || bm.bmHeight > 512 {
		return nil
	}
	w, h := int(bm.bmWidth), int(bm.bmHeight)
	color := dibPixels(info.hbmColor, w, h)
	if color == nil {
		return nil
	}
	hasAlpha := false
	for i := 3; i < len(color); i += 4 {
		if color[i] != 0 {
			hasAlpha = true
			break
		}
	}
	var mask []byte
	if !hasAlpha {
		mask = dibPixels(info.hbmMask, w, h)
	}
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < w*h; i++ {
		b, g, r, a := color[i*4], color[i*4+1], color[i*4+2], color[i*4+3]
		if !hasAlpha {
			// The mask is white where the icon is transparent.
			a = 0xff
			if mask != nil && mask[i*4] != 0 {
				a = 0
			}
		}
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = r, g, b, a
	}
	return img
}

// dibPixels reads a bitmap as 32-bit BGRA rows, top first.
func dibPixels(bmp windows.Handle, w, h int) []byte {
	dc, _, _ := getDC.Call(0)
	if dc == 0 {
		return nil
	}
	defer releaseDC.Call(0, dc)
	header := bitmapInfoHeader{biWidth: int32(w), biHeight: -int32(h), biPlanes: 1, biBitCount: 32}
	header.biSize = uint32(unsafe.Sizeof(header))
	// BITMAPINFO is the header and a color table, which 32 bits have none
	// of; room for one entry all the same.
	info := struct {
		header bitmapInfoHeader
		colors [1]uint32
	}{header: header}
	pixels := make([]byte, w*h*4)
	const dibRGBColors = 0
	if n, _, _ := getDIBits.Call(dc, uintptr(bmp), 0, uintptr(h), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&info)), dibRGBColors); n == 0 {
		return nil
	}
	return pixels
}
