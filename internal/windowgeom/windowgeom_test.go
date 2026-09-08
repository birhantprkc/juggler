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

// A frame the caller worked out for itself — a window opened over something the
// user was already looking at — is fitted onto the screen it lands on before it
// is placed. PlaceVisible only promises a header you can drag; a window with its
// far edge off the screen is one you can drag but cannot read.
func TestFitOnScreenLeavesAFrameThatAlreadyFits(t *testing.T) {
	screens := testScreens()
	frame := core.WindowState{X: 100, Y: 80, Width: 800, Height: 700, HasPos: true}

	if got := FitOnScreen(frame, screens); got != frame {
		t.Fatalf("FitOnScreen() = %+v, want it untouched", got)
	}
}

func TestFitOnScreenPullsBackAnOverhangingFrame(t *testing.T) {
	screens := testScreens()
	frame := core.WindowState{X: 1500, Y: 900, Width: 800, Height: 600, HasPos: true}

	got := FitOnScreen(frame, screens)
	if got.X != 1920-800 || got.Y != 1040-600 {
		t.Fatalf("FitOnScreen() origin = %d,%d, want %d,%d", got.X, got.Y, 1920-800, 1040-600)
	}
	if got.Width != 800 || got.Height != 600 {
		t.Fatalf("FitOnScreen() size = %dx%d, want it unchanged", got.Width, got.Height)
	}
}

// Moving a window is the caller's business; resizing one is not. A frame with
// nowhere to fit goes to the top-left of the work area with its size intact.
func TestFitOnScreenPinsAFrameTooBigForTheScreen(t *testing.T) {
	screens := testScreens()
	frame := core.WindowState{X: 300, Y: 200, Width: 2400, Height: 1200, HasPos: true}

	got := FitOnScreen(frame, screens)
	if got.X != 0 || got.Y != 0 {
		t.Fatalf("FitOnScreen() origin = %d,%d, want the work area's own", got.X, got.Y)
	}
	if got.Width != 2400 || got.Height != 1200 {
		t.Fatalf("FitOnScreen() size = %dx%d, want it unchanged", got.Width, got.Height)
	}
}

// The screen it is on is the one it mostly lies on, so a window popped out on
// the second display is fitted to that display rather than dragged home.
func TestFitOnScreenStaysOnTheScreenTheFrameIsOn(t *testing.T) {
	screens := testScreens()
	frame := core.WindowState{X: -1000, Y: 700, Width: 800, Height: 600, HasPos: true}

	got := FitOnScreen(frame, screens)
	if got.X != -1000 {
		t.Errorf("FitOnScreen() x = %d, want it left where it was on the second display", got.X)
	}
	if got.Y != 984-600 {
		t.Errorf("FitOnScreen() y = %d, want %d — that display's work area is shorter", got.Y, 984-600)
	}
}

// Nothing to fit: a frame with no position of its own is placed by the centring
// default, and inventing coordinates for it here would take that away.
func TestFitOnScreenIgnoresAFrameWithNothingToFit(t *testing.T) {
	screens := testScreens()
	for _, frame := range []core.WindowState{
		{Width: 800, Height: 600},
		{X: 4000, Y: 4000, HasPos: true},
		{},
	} {
		if got := FitOnScreen(frame, screens); got != frame {
			t.Errorf("FitOnScreen(%+v) = %+v, want it untouched", frame, got)
		}
	}
	frame := core.WindowState{X: 4000, Y: 4000, Width: 800, Height: 600, HasPos: true}
	if got := FitOnScreen(frame, nil); got != frame {
		t.Errorf("FitOnScreen() with no screens = %+v, want it untouched", got)
	}
}

func testScreens() []*application.Screen {
	return []*application.Screen{
		{IsPrimary: true, WorkArea: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040}},
		{WorkArea: application.Rect{X: -1280, Y: 0, Width: 1280, Height: 984}},
	}
}
