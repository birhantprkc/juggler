// Package windowgeom holds the window geometry persistence shared by the two
// Wails hosts: the server's test-pool window (cmd/juggler/app) and the desktop
// app's window registry (cmd/juggler-app). Both read the same frame out of the
// same session store — one in-process, one over the window-state HTTP route —
// so the questions "what frame is this window in", "when do I write it" and
// "where do I put a window given a saved frame" have one answer each.
//
// What deliberately stays with the caller: the sink (which store the frame goes
// to), the error policy, and marshalling onto the main thread. Capture reads
// live native state and so must run on the main thread, but the two hosts hop
// there at different layers, and the server's close path skips the hop on
// purpose — so the hop is documented here and performed by the caller.
package windowgeom

import (
	"time"

	"juggler/cmd/juggler/core"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Default frame for a window that has no saved geometry.
const (
	DefaultWidth  = 1400
	DefaultHeight = 900
)

// SaveDebounce collapses a burst of window move/resize events into a single
// geometry write ~this long after the last change.
const SaveDebounce = 300 * time.Millisecond

// Window is the slice of a Wails window a Tracker reads. Taking an interface
// rather than *application.WebviewWindow keeps the capture rules testable
// without an app to host a real window.
type Window interface {
	IsMaximised() bool
	IsFullscreen() bool
	Position() (int, int)
	Size() (int, int)
}

// Tracker remembers the last known normal (non-maximised, non-fullscreen)
// frame of one window, which is what makes a maximised window still able to
// persist a sane restore frame alongside its maximised flag.
type Tracker struct {
	lastPos core.WindowState
}

// NewTracker returns a tracker seeded with a previously saved frame. Seeding
// matters at startup: a window that comes up maximised has no live normal-state
// sample of its own yet, and the saved frame is the right thing to keep
// re-writing until the user restores it.
func NewTracker(seed core.WindowState) *Tracker {
	return &Tracker{lastPos: seed}
}

// Capture reads the window's current geometry and state, and updates the
// remembered normal-state frame. Must be called on the main thread.
//
// Returns (zero, false) when there is nothing worth writing: Wails' Size() and
// Position() return zeros when the native window isn't constructed yet (early
// startup) or has been destroyed, and a maximised window with no normal-state
// sample would only write junk for the frame underneath. Both cases leave the
// stored frame alone rather than clobbering the user's real geometry.
func (t *Tracker) Capture(win Window) (core.WindowState, bool) {
	maximised := win.IsMaximised()
	fullscreen := win.IsFullscreen()
	if !maximised && !fullscreen {
		x, y := win.Position()
		w, h := win.Size()
		if w <= 0 || h <= 0 {
			return core.WindowState{}, false
		}
		t.lastPos = core.WindowState{X: x, Y: y, Width: w, Height: h, HasPos: true}
	} else if !t.lastPos.HasPos {
		return core.WindowState{}, false
	}
	return core.WindowState{
		X:          t.lastPos.X,
		Y:          t.lastPos.Y,
		Width:      t.lastPos.Width,
		Height:     t.lastPos.Height,
		HasPos:     t.lastPos.HasPos,
		Maximised:  maximised,
		Fullscreen: fullscreen,
	}, true
}

// Debouncer collapses the many move/resize events Wails fires during one drag
// into a single write, one SaveDebounce after the last of them.
type Debouncer struct {
	ch chan struct{}
}

// NewDebouncer returns a debouncer ready to be triggered; call Run on its own
// goroutine to do the saving.
func NewDebouncer() *Debouncer {
	return &Debouncer{ch: make(chan struct{}, 1)}
}

// Trigger wakes the save loop. Non-blocking, so it is safe to call from an
// event handler on every frame of a drag.
func (d *Debouncer) Trigger() {
	select {
	case d.ch <- struct{}{}:
	default:
	}
}

// Run calls save once per settled burst of triggers, and returns when stop is
// closed. A nil stop channel never fires, which is what a host wants when its
// window lives as long as the process.
func (d *Debouncer) Run(stop <-chan struct{}, save func()) {
	var timerC <-chan time.Time
	for {
		select {
		case <-d.ch:
			timerC = time.After(SaveDebounce)
		case <-timerC:
			timerC = nil
			save()
		case <-stop:
			return
		}
	}
}

// Placement is a saved frame translated into the window options Wails needs at
// construction time. Position and state have to be right before the page first
// loads — applying them later loses to Wails' own centring default.
type Placement struct {
	Width, Height int
	X, Y          int
	Position      application.WindowStartPosition
	State         application.WindowState
}

// Place turns a saved frame into a Placement, falling back to a centred default
// window for anything the frame doesn't say. A zero WindowState therefore gives
// exactly the first-run placement, which is what a caller with no saved frame
// should pass.
func Place(saved core.WindowState) Placement {
	p := Placement{
		Width:    DefaultWidth,
		Height:   DefaultHeight,
		Position: application.WindowCentered,
		State:    application.WindowStateNormal,
	}
	if saved.Width > 0 && saved.Height > 0 {
		p.Width, p.Height = saved.Width, saved.Height
	}
	if saved.HasPos {
		p.X, p.Y = saved.X, saved.Y
		p.Position = application.WindowXY
	}
	switch {
	case saved.Maximised:
		p.State = application.WindowStateMaximised
	case saved.Fullscreen:
		p.State = application.WindowStateFullscreen
	}
	return p
}
