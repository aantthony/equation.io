#if os(macOS)
  import AppKit
  import SwiftUI

  /// The Mac window's title bar gets out of the way of work, as a writing
  /// app's does: typing, or a drag or scroll below it, fades the bar, its
  /// buttons and the traffic lights away, leaving the window all graph and
  /// equations; the pointer coming up to the top brings them back.
  struct WindowChrome: NSViewRepresentable {
    func makeNSView(context: Context) -> ChromeFader { ChromeFader() }
    func updateNSView(_ view: ChromeFader, context: Context) {}
  }

  final class ChromeFader: NSView {
    private var monitor: Any?
    private var observers: [NSObjectProtocol] = []
    private var shown = true

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      detach()
      guard let window else { return }
      // The pointer's moves reach the monitor only from a window that asks for them.
      window.acceptsMouseMovedEvents = true
      let kinds: NSEvent.EventTypeMask = [.keyDown, .leftMouseDragged, .scrollWheel, .magnify, .mouseMoved]
      monitor = NSEvent.addLocalMonitorForEvents(matching: kinds) { [weak self] event in
        self?.saw(event)
        return event
      }
      // Full screen keeps its bar in a window of its own, which the system
      // already hides; a window in the background shows what it is.
      let center = NotificationCenter.default
      for name in [NSWindow.didResignKeyNotification, NSWindow.willEnterFullScreenNotification] {
        observers.append(
          center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.show(true) }
          })
      }
    }

    private func detach() {
      if let monitor { NSEvent.removeMonitor(monitor) }
      monitor = nil
      observers.forEach(NotificationCenter.default.removeObserver)
      observers = []
    }

    /// The title bar and everything in it: the traffic lights' container.
    private var bar: NSView? {
      window?.standardWindowButton(.closeButton)?.superview?.superview
    }

    private func saw(_ event: NSEvent) {
      guard let window, event.window === window else { return }
      // In the bar's strip, at the top of the window.
      let over = event.locationInWindow.y >= window.contentLayoutRect.maxY
      switch event.type {
      case .mouseMoved:
        if over { show(true) }
      case .keyDown:
        // Typing, not a menu's shortcut; the pointer resting on the bar keeps it.
        let pointer = window.mouseLocationOutsideOfEventStream
        let resting = pointer.y >= window.contentLayoutRect.maxY && pointer.y <= window.frame.height
        if !event.modifierFlags.contains(.command), !resting { show(false) }
      default:
        if !over { show(false) }
      }
    }

    private func show(_ on: Bool) {
      guard let window, let bar, on != shown else { return }
      // Someone who cannot see the bar come back keeps it; so does full screen.
      if !on, window.styleMask.contains(.fullScreen) || NSWorkspace.shared.isVoiceOverEnabled { return }
      shown = on
      NSAnimationContext.runAnimationGroup { context in
        // Gone slowly, back at once: a click on a button it hid lands on one that shows.
        context.duration = on ? 0.12 : 0.4
        bar.animator().alphaValue = on ? 1 : 0
      }
    }
  }
#endif
