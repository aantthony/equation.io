import EquationRender
import MetalKit

// The platform's events, handed to the graph's Metal view as what they mean
// (MetalCanvas.swift, "Under the hand"): a drag, a scroll, a pinch, a double
// click or tap. Points are from the view's top-left corner, y down.
//
// On the Mac: a drag pans a 2D panel and orbits a 3D one (with Shift, or the
// right button, it slides the camera's target); two fingers or a wheel pan in
// 2D and zoom in 3D (with Shift: zoom in 2D, slide in 3D); a pinch zooms; a
// double click zooms in, and out with Option. On iPhone and iPad: one finger
// drags, two slide a 3D camera's target, a pinch zooms, a double tap zooms
// in and a two-finger one out; a trackpad's scroll does what the Mac's does.

#if os(macOS)
  extension MetalCanvas {
    func installGestures() {}

    private func point(_ event: NSEvent) -> CGPoint {
      let p = convert(event.locationInWindow, from: nil)
      return CGPoint(x: p.x, y: bounds.height - p.y)
    }

    override func mouseDown(with event: NSEvent) {
      last = point(event)
      if event.clickCount == 2 {
        doubleTapped(at: point(event), out: event.modifierFlags.contains(.option))
      } else {
        began(at: point(event), pan: event.modifierFlags.contains(.shift))
      }
    }

    override func mouseDragged(with event: NSEvent) {
      let p = point(event)
      dragged(to: p, dx: p.x - last.x, dy: p.y - last.y)
      last = p
    }

    override func mouseUp(with event: NSEvent) { ended() }

    override func rightMouseDown(with event: NSEvent) {
      last = point(event)
      began(at: last, pan: true)
    }

    override func rightMouseDragged(with event: NSEvent) { mouseDragged(with: event) }

    override func rightMouseUp(with event: NSEvent) { ended() }

    override func scrollWheel(with event: NSEvent) {
      // A wheel's clicks are lines, not points.
      let lines = event.hasPreciseScrollingDeltas ? 1.0 : 10.0
      let shift = event.modifierFlags.contains(.shift)
      var (dx, dy) = (event.scrollingDeltaX * lines, event.scrollingDeltaY * lines)
      // Shift turns a wheel's motion sideways: take it back.
      if shift, dy == 0 { (dx, dy) = (0, dx) }
      scrolled(at: point(event), dx: dx, dy: dy, modified: shift)
    }

    override func magnify(with event: NSEvent) {
      pinched(at: point(event), by: 1 / max(1 + event.magnification, 0.01))
    }
  }
#else
  extension MetalCanvas: UIGestureRecognizerDelegate {
    func installGestures() {
      let pan = UIPanGestureRecognizer(target: self, action: #selector(panned))
      pan.allowedScrollTypesMask = .all
      pan.maximumNumberOfTouches = 2
      pan.delegate = self
      addGestureRecognizer(pan)
      let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinching))
      pinch.delegate = self
      addGestureRecognizer(pinch)
      for touches in 1...2 {
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.numberOfTapsRequired = 2
        tap.numberOfTouchesRequired = touches
        addGestureRecognizer(tap)
      }
    }

    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
      let p = gesture.location(in: self)
      let moved = gesture.translation(in: self)
      gesture.setTranslation(.zero, in: self)
      // No touches: a trackpad's scroll (or a mouse's wheel).
      if gesture.state == .began { scrolling = gesture.numberOfTouches == 0 }
      if scrolling {
        if gesture.state == .began || gesture.state == .changed {
          scrolled(at: p, dx: moved.x, dy: moved.y, modified: gesture.modifierFlags.contains(.shift))
        } else {
          flushWriteback()
        }
        return
      }
      switch gesture.state {
      case .began:
        // Where the finger came down, before it moved far enough to be a drag;
        // a finger covers more than a pointer does.
        began(at: CGPoint(x: p.x - moved.x, y: p.y - moved.y), pan: gesture.numberOfTouches >= 2, radius: 22)
        dragged(to: p, dx: moved.x, dy: moved.y)
      case .changed:
        // A second finger joining turns an orbit into a slide, and lets go of a point.
        if gesture.numberOfTouches >= 2, !panning {
          panning = true
          grab = nil
          viewport.hot = nil
        }
        dragged(to: p, dx: moved.x, dy: moved.y)
      default:
        ended()
      }
    }

    @objc private func pinching(_ gesture: UIPinchGestureRecognizer) {
      guard gesture.scale > 0, gesture.state == .began || gesture.state == .changed else { return }
      pinched(at: gesture.location(in: self), by: 1 / gesture.scale)
      gesture.scale = 1
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
      doubleTapped(at: gesture.location(in: self), out: gesture.numberOfTouchesRequired == 2)
    }

    /// A pinch pans as its fingers move.
    func gestureRecognizer(_ a: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith b: UIGestureRecognizer) -> Bool {
      true
    }
  }
#endif

#if DEBUG
  extension MetalCanvas {
    /// EQUATION_SCRIPT: gestures to play once the graph is up, and pictures
    /// to take of it, for checking the view without a hand or a screen.
    /// Steps are separated by `;`, positions in points from the top-left corner:
    ///
    ///   drag x0 y0 x1 y1 [pan]   a drag (twelve moves, then let go at rest)
    ///   scroll x y dx dy [shift] a two-finger scroll
    ///   pinch x y factor         a pinch
    ///   tap x y [out]            a double click
    ///   spin rate                Ask's move_view spin
    ///   wait seconds
    ///   shot name                the frame, as name.png in the app's temporary directory
    ///   rows name                the document's rows, as name.txt there
    ///   state name               each panel's window or camera, as name.txt there
    ///
    /// A name that is an absolute path is written there instead, which a
    /// build without the sandbox can do (`xcodebuild … ENABLE_APP_SANDBOX=NO`):
    /// nothing else can read the sandboxed app's own directory.
    func runDebugScript() {
      guard let script = ProcessInfo.processInfo.environment["EQUATION_SCRIPT"] else { return }
      let steps = script.split(separator: ";").map { $0.split(separator: " ").map(String.init) }
      Task { @MainActor [weak self] in
        // Let the window come up and the first frame draw.
        try? await Task.sleep(for: .seconds(1))
        for step in steps {
          guard let self, let verb = step.first else { return }
          let n = step.dropFirst().map { Double($0) ?? 0 }
          let file = { (ext: String) in
            let name = "\(step.last ?? "out").\(ext)"
            return name.hasPrefix("/")
              ? URL(fileURLWithPath: name) : URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
          }
          switch verb {
          case "drag" where n.count >= 4:
            self.began(at: CGPoint(x: n[0], y: n[1]), pan: step.last == "pan")
            for k in 1...12 {
              let f = Double(k) / 12
              self.dragged(
                to: CGPoint(x: n[0] + (n[2] - n[0]) * f, y: n[1] + (n[3] - n[1]) * f), dx: (n[2] - n[0]) / 12,
                dy: (n[3] - n[1]) / 12)
              try? await Task.sleep(for: .milliseconds(16))
            }
            try? await Task.sleep(for: .milliseconds(150))
            self.ended()
          case "scroll" where n.count >= 4:
            self.scrolled(at: CGPoint(x: n[0], y: n[1]), dx: n[2], dy: n[3], modified: step.last == "shift")
          case "pinch" where n.count >= 3:
            self.pinched(at: CGPoint(x: n[0], y: n[1]), by: n[2])
          case "tap" where n.count >= 2:
            self.doubleTapped(at: CGPoint(x: n[0], y: n[1]), out: step.last == "out")
          case "spin" where n.count >= 1:
            self.setSpin(n[0])
          case "wait" where n.count >= 1:
            try? await Task.sleep(for: .seconds(n[0]))
          case "shot":
            self.writeShot(to: file("png"))
          case "rows":
            let rows = (self.model?.rows() ?? []).joined(separator: "\n")
            try? rows.write(to: file("txt"), atomically: true, encoding: .utf8)
          case "state":
            let lines = self.viewport.states.map { state in
              state.spatial
                ? formatCameraRow(state.camera, spin: state.spin)
                : "view(cx = \(state.view.cx), cy = \(state.view.cy), upp = \(state.view.upp))"
            }
            let pixels = self.viewport.pixels
            let size = "size \(pixels.width) \(pixels.height) scale \(self.scale) drawn \(self.drawn)"
            try? ([size] + lines).joined(separator: "\n").write(to: file("txt"), atomically: true, encoding: .utf8)
          default:
            print("EQUATION_SCRIPT: can't read step \(step.joined(separator: " "))")
          }
        }
      }
    }

    /// The frame the view shows now, drawn again offscreen with its overlay
    /// and written as a PNG.
    private func writeShot(to url: URL) {
      guard let content, let metal = MetalContext() else { return }
      let renderer = FrameRenderer(metal)
      renderer.helpers = content.panels.lazy.compactMap { $0.space?.helpers }.first
      let time = viewport.time
      guard
        let image = renderer.image(
          of: viewport.frames(content, time: time, overlay: true, theme: theme), width: Int(viewport.pixels.width),
          height: Int(viewport.pixels.height), dpr: viewport.scale, time: time, theme: theme),
        let out = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
      else { return }
      CGImageDestinationAddImage(out, image, nil)
      CGImageDestinationFinalize(out)
      print("EQUATION_SCRIPT: wrote \(url.path)")
    }
  }
#endif
