package windowgeom

import (
	"testing"

	"juggler/cmd/juggler/core"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type fakeWindow struct {
	maximised  bool
	fullscreen bool
	minimised  bool
	x, y       int
	width      int
	height     int
}

func (w fakeWindow) IsMaximised() bool  { return w.maximised }
func (w fakeWindow) IsFullscreen() bool { return w.fullscreen }
func (w fakeWindow) IsMinimised() bool  { return w.minimised }
func (w fakeWindow) Position() (int, int) {
	return w.x, w.y
}
func (w fakeWindow) Size() (int, int) {
	return w.width, w.height
}

func TestCaptureIgnoresMinimisedWindow(t *testing.T) {
	seed := core.WindowState{X: 120, Y: 80, Width: 1400, Height: 900, HasPos: true}
	tracker := NewTracker(seed)

	if got, ok := tracker.Capture(fakeWindow{
		minimised: true,
		x:         -32000,
		y:         -32000,
		width:     1400,
		height:    900,
	}); ok {
		t.Fatalf("Capture() while minimised = (%+v, true), want (_, false)", got)
	}

	got, ok := tracker.Capture(fakeWindow{x: 150, y: 100, width: 1300, height: 800})
	if !ok {
		t.Fatal("Capture() after restore returned false")
	}
	if got.X != 150 || got.Y != 100 || got.Width != 1300 || got.Height != 800 {
		t.Fatalf("Capture() after restore = %+v, want restored frame", got)
	}
}

func TestPlaceVisibleKeepsFrameWithDraggableHeader(t *testing.T) {
	screens := testScreens()
	saved := core.WindowState{X: -1200, Y: 50, Width: 1000, Height: 800, HasPos: true}

	got := PlaceVisible(saved, screens)
	if got.Position != application.WindowXY || got.X != saved.X || got.Y != saved.Y {
		t.Fatalf("PlaceVisible() = %+v, want saved placement", got)
	}
	if got.Screen != nil {
		t.Fatalf("PlaceVisible() screen = %+v, want nil for unchanged absolute placement", got.Screen)
	}
}

func TestPlaceVisibleRecentresStrandedFrame(t *testing.T) {
	screens := testScreens()
	saved := core.WindowState{X: -32000, Y: -32000, Width: 1400, Height: 900, HasPos: true}

	got := PlaceVisible(saved, screens)
	if got.Position != application.WindowCentered {
		t.Fatalf("PlaceVisible() position = %v, want WindowCentered", got.Position)
	}
	if got.Screen != screens[0] {
		t.Fatalf("PlaceVisible() screen = %+v, want primary screen", got.Screen)
	}
	if got.Width != 1400 || got.Height != 900 {
		t.Fatalf("PlaceVisible() size = %dx%d, want 1400x900", got.Width, got.Height)
	}
}

func TestPlaceVisibleRecentresFrameWithHiddenHeader(t *testing.T) {
	screens := testScreens()
	saved := core.WindowState{X: 100, Y: -850, Width: 1400, Height: 900, HasPos: true}

	got := PlaceVisible(saved, screens)
	if got.Position != application.WindowCentered || got.Screen != screens[0] {
		t.Fatalf("PlaceVisible() = %+v, want centred on primary", got)
	}
}

func TestPlaceVisibleClampsRescuedFrameToWorkArea(t *testing.T) {
	screens := testScreens()
	saved := core.WindowState{X: 4000, Y: 0, Width: 3000, Height: 2000, HasPos: true}

	got := PlaceVisible(saved, screens)
	if got.Width != 1920 || got.Height != 1040 {
		t.Fatalf("PlaceVisible() size = %dx%d, want 1920x1040", got.Width, got.Height)
	}
}

func testScreens() []*application.Screen {
	return []*application.Screen{
		{IsPrimary: true, WorkArea: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040}},
		{WorkArea: application.Rect{X: -1280, Y: 0, Width: 1280, Height: 984}},
	}
}
