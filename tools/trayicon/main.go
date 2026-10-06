// Trayicon renders the menu bar icon, a template image macOS tints to
// match the menu bar: resources/tray.png (18 pt at 2x).
//
//	go run ./tools/trayicon
package main

import (
	"image/png"
	"log"
	"os"

	"github.com/egoist/mygo/ui"
)

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="#000" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round">
<path d="M18 4.5 30 11v14l-12 6.5L6 25V11Z"/>
<path d="M6 11l12 6.5L30 11M18 17.5V31.5"/>
</svg>`

func main() {
	svg := ui.MustParseSVG([]byte(icon))
	img := ui.Render(func(c *ui.Context) {
		c.Root().Background(ui.Transparent)
		ui.Image(c, svg).Size(36, 36)
	}, 36, 36, 1)
	f, err := os.Create("resources/tray.png")
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		log.Fatal(err)
	}
}
