//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// installAppMenu builds the native application menu. File ▸ Open… asks the
// focused window's page to show the project picker; File ▸ New Window opens
// another in-process window (no project → picker); View carries dev-only
// reload/devtools plus Toggle Full Screen; Help ▸ Learn More opens the browser.
func installAppMenu(a *appState, devMode bool) {
	// Linux renders the application menu as a GtkMenuBar embedded at the top of
	// the window (Wails prepends it into the window's vbox), which looks wrong
	// against our custom header. macOS shows it as the global top-of-screen menu
	// bar (correct) and the frameless Windows window doesn't display it at all,
	// so only Linux needs suppressing. The Linux window builds its menu bar
	// solely from globalApplication.applicationMenu, and the default-menu
	// fallback is darwin-only — so by never calling Menu.Set here, applicationMenu
	// stays nil and the window attaches no menu bar at all.
	if runtime.GOOS == "linux" {
		return
	}
	menu := application.NewMenu()
	buildAppMenu(a, menu)

	fileMenu := menu.AddSubmenu("File")
	fileMenu.Add("Open...").
		SetAccelerator("CmdOrCtrl+o").
		OnClick(func(_ *application.Context) {
			if win := a.app.Window.Current(); win != nil {
				win.ExecJS("window.dispatchEvent(new CustomEvent('juggler:open-project'))")
			}
		})
	fileMenu.Add("New Window").
		SetAccelerator("CmdOrCtrl+n").
		OnClick(func(_ *application.Context) { a.openWindowForProject("", a.currentWindowTheme()) })
	fileMenu.AddSeparator()
	fileMenu.AddRole(application.CloseWindow)

	menu.AddRole(application.EditMenu)

	dispatch := func(event string) func(*application.Context) {
		return func(_ *application.Context) {
			if win := a.app.Window.Current(); win != nil {
				win.ExecJS("window.dispatchEvent(new CustomEvent('" + event + "'))")
			}
		}
	}

	viewMenu := menu.AddSubmenu("View")
	// Font-size zoom (mirrors the header bar's −/+ buttons), not the webview's
	// own page zoom — that breaks the fixed layout. The page also handles the
	// Cmd +/− keypresses directly for browser tabs that have no native menu.
	viewMenu.Add("Zoom In").SetAccelerator("CmdOrCtrl+plus").OnClick(dispatch("juggler:zoom-in"))
	viewMenu.Add("Zoom Out").SetAccelerator("CmdOrCtrl+-").OnClick(dispatch("juggler:zoom-out"))
	viewMenu.AddSeparator()
	if devMode {
		viewMenu.AddRole(application.Reload)
		viewMenu.AddRole(application.ForceReload)
		viewMenu.AddRole(application.OpenDevTools)
		viewMenu.AddSeparator()
	}
	viewMenu.AddRole(application.ToggleFullscreen)

	menu.AddRole(application.WindowMenu)

	helpMenu := menu.AddSubmenu("Help")
	helpMenu.Add("Learn More").
		OnClick(func(_ *application.Context) {
			if err := openInBrowser("https://juggler.studio"); err != nil {
				logf("open Learn More failed: %v", err)
			}
		})

	a.app.Menu.Set(menu)
}
