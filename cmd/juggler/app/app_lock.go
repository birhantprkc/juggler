//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// acquireInstance enforces single-instance-per-project. The happy path is one
// TryAcquire call; the rest of this method handles the contended case where
// .juggler/juggler.lock is held — possibly by a live instance, possibly by a
// crashed one that left stale info.
func (a *App) acquireInstance() error {
	if a.projectPath == "" {
		// No-project mode: nothing to lock. The user picks a project at
		// runtime; locking happens then via the server's project switch.
		return nil
	}
	lock := core.NewInstanceLock(a.projectPath)
	a.lock = lock
	// The server normally takes ownership and releases this lock during Shutdown.
	// Register a startup-failure backstop now: any later phase can fail before the
	// server exists, and its cleanup must not leave the lock held by this process.
	a.pushCleanup(func() {
		if a.lock != nil {
			_ = a.lock.Release()
		}
	})

	res, err := lock.TryAcquire(a.cfg.Server.Port, a.cfg.Server.Host)
	if err != nil {
		jlog.Error("Failed to check instance lock: %v", err)
		return err
	}

	if res.FirstRun {
		jlog.Info("📁 Created .juggler/ folder for this project")
		jlog.Info("   Juggler can read and modify files in this directory.")
		jlog.Info("   Review all AI-suggested changes before accepting.")
		jlog.Info("")
	}

	if !res.Acquired {
		if a.flags.sessionChild {
			// A session child is only ever spawned by a supervisor that has
			// already arbitrated ownership, so a held lock means a genuinely
			// live holder: refuse and report, never prompt or kill.
			return fmt.Errorf("project %s is locked by another juggler instance", a.projectPath)
		}
		if err := a.handleExistingInstance(res.Existing); err != nil {
			return err
		}
	}

	// Lock ownership transfers to the server (via Config.BootLock) so that
	// runtime project switches can release it before acquiring a new one. The
	// cleanup registered above remains an idempotent backstop for startup errors
	// and abnormal paths which bypass server construction.
	return nil
}

// handleExistingInstance handles the case where TryAcquire failed: verify
// whether the holder is alive, prompt (or --kill-existing) to kill it, and
// retry. Returns nil only when the lock is now held by us.
func (a *App) handleExistingInstance(existing *core.InstanceInfo) error {
	if existing == nil {
		return fmt.Errorf("failed to acquire instance lock (no existing instance info)")
	}

	isRunning, _ := core.VerifyInstance(existing, a.projectPath)
	if !isRunning {
		// Stale lock — retry once.
		res, err := a.lock.TryAcquire(a.cfg.Server.Port, a.cfg.Server.Host)
		if err != nil || !res.Acquired {
			return fmt.Errorf("failed to acquire instance lock")
		}
		return nil
	}

	fmt.Println()
	fmt.Println("⚠️  Juggler is already running for this project!")
	fmt.Printf("   URL: http://%s:%d/\n", existing.Host, existing.Port)
	fmt.Println()

	shouldKill := a.flags.killExisting || promptKillInstance()
	if !shouldKill {
		fmt.Println("Exiting. Use the URL above to open the existing instance.")
		os.Exit(0)
	}

	fmt.Println("🔄 Requesting existing instance to shut down...")
	if err := core.KillExistingInstance(existing, a.projectPath); err != nil {
		return fmt.Errorf("failed to stop existing instance: %w", err)
	}
	fmt.Println("✅ Existing instance stopped")

	time.Sleep(postKillSettleDelay)

	res, err := a.lock.TryAcquire(a.cfg.Server.Port, a.cfg.Server.Host)
	if err != nil || !res.Acquired {
		return fmt.Errorf("failed to acquire lock after stopping existing instance")
	}
	return nil
}

// postKillSettleDelay gives the previous instance's OS-level resources
// (port binding, flock) a moment to be reclaimed before we retry TryAcquire.
const postKillSettleDelay = 500 * time.Millisecond

// promptKillInstance asks the user whether to kill the existing instance.
func promptKillInstance() bool {
	fmt.Print("Kill existing instance and start new one? [y/N]: ")
	resp, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	resp = strings.TrimSpace(strings.ToLower(resp))
	return resp == "y" || resp == "yes"
}
