import EquationRender
import MetalKit

// The platform's events, handed to the graph's Metal view as what they mean
// (MetalCanvas.swift, "Under the hand"): a drag, a scroll, a pinch, a double
// click or tap. Points are from the view's top-left corner, y down.
//
// On the Mac: a drag pans a 2D panel and orbits a 3D one (with Shift, or the
// right button, it slides the camera's target); two fingers or a wheel pan in
// 2D and zoom in 3D (with Shift: zoom in 2D, slide in 3D); a pinch zooms; a
// double click zooms in, and out with Option; the pointer over a point a drag
// can move is an open hand, and over any point reads its coordinates. On
// iPhone and iPad: one finger
// drags, two slide a 3D camera's target, a pinch zooms, a double tap zooms
// in and a two-finger one out; a trackpad's scroll does what the Mac's does.

#if os(macOS)
  extension MetalCanvas {
    func installGestures() {
      // The pointer's moves with no button down: the cursor, and what it rests on.
      addTrackingArea(
        NSTrackingArea(
          rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
          owner: self))
    }

    override func mouseMoved(with event: NSEvent) {
      (hovered(at: point(event)) ? NSCursor.openHand : .arrow).set()
    }

    override func mouseExited(with event: NSEvent) {
      hovered(at: nil)
      NSCursor.arrow.set()
    }

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
        if grab != nil { NSCursor.closedHand.set() }
      }
    }

    override func mouseDragged(with event: NSEvent) {
      let p = point(event)
      dragged(to: p, dx: p.x - last.x, dy: p.y - last.y)
      last = p
    }

    override func mouseUp(with event: NSEvent) {
      ended()
      (hovered(at: point(event)) ? NSCursor.openHand : .arrow).set()
    }

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
        let tap = UITapGestureRecognizer(target: self, action: #selector(doubleTap))
        tap.numberOfTapsRequired = 2
        tap.numberOfTouchesRequired = touches
        addGestureRecognizer(tap)
      }
      // One tap drops a seed on a vector field; the first of two does too,
      // and the second lets go of them all, as the site's clicks do.
      addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(singleTap)))
    }

    @objc private func singleTap(_ gesture: UITapGestureRecognizer) {
      tapped(at: gesture.location(in: self))
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

    @objc private func doubleTap(_ gesture: UITapGestureRecognizer) {
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
    ///   click x y                a click that goes nowhere (drops a seed on a vector field)
    ///   spin rate                Ask's move_view spin
    ///   hover x y                the pointer at rest there (`state` says what it reads)
    ///   zoom factor              the Zoom commands (0.5 in, 2 out), and wait for the glide
    ///   restart                  the Restart command: t and the states from the start
    ///   at seconds               hold the clock at a time: a picture of that moment
    ///   set row | row | …        replace the document's rows (an edit, not a new graph)
    ///   slide row value          drag row's slider to a value (row from 0), and let go
    ///   toggle row id            flip a row's display toggle (levels, sums, streamlines, arrows,
    ///                            certify, tensor, combK, combT)
    ///   undo                     the window's Undo, once
    ///   import path [path…]      give the window data files (CSV), as the importer or a drop does
    ///   save path                the document's bytes, as saving writes them, to a file
    ///   load path                open a document's bytes in the window, as opening does
    ///   ungrouped                stop grouping a gesture's rewrites, to see what grouping does
    ///
    /// On the Mac every move of a drag is followed by an event of the
    /// application's own, as a hand's moves each are one: undo groups what
    /// is registered by event, and a script's moves would otherwise all be one.
    ///   ask name tool args…      one of Ask's tools, its answer as name.txt:
    ///                              get | check row | row | set row | row | view x0 x1 y0 y1 [seconds]
    ///                              | camera theta phi radius [seconds] | slider a to [seconds]
    ///   wait seconds
    ///   shot name                the frame, as name.png in the app's temporary directory
    ///   rows name                the document's rows, as name.txt there
    ///   state name               each panel's window or camera, as name.txt there, with
    ///                            its seeds and each row's status and toggles
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
              await Self.pump()
            }
            try? await Task.sleep(for: .milliseconds(150))
            self.ended()
            await Self.pump()
          case "scroll" where n.count >= 4:
            self.scrolled(at: CGPoint(x: n[0], y: n[1]), dx: n[2], dy: n[3], modified: step.last == "shift")
          case "pinch" where n.count >= 3:
            self.pinched(at: CGPoint(x: n[0], y: n[1]), by: n[2])
          case "click" where n.count >= 2:
            self.tapped(at: CGPoint(x: n[0], y: n[1]))
          case "tap" where n.count >= 2:
            self.doubleTapped(at: CGPoint(x: n[0], y: n[1]), out: step.last == "out")
          case "spin" where n.count >= 1:
            self.setSpin(n[0])
          case "hover" where n.count >= 2:
            self.hovered(at: CGPoint(x: n[0], y: n[1]))
          case "zoom" where n.count >= 1:
            self.model?.zoom(by: n[0])
            try? await Task.sleep(for: .milliseconds(500))
          case "restart":
            self.model?.restart()
          case "at" where n.count >= 1:
            self.viewport.frozen = n[0]
            self.redraw()
          case "set":
            let rows = step.dropFirst().joined(separator: " ").split(separator: "|")
            self.model?.edit(rows.map { $0.trimmingCharacters(in: .whitespaces) })
            await Self.pump()
          case "slide" where n.count >= 2:
            for k in 1...4 {
              self.model?.setSlider(row: Int(n[0]), to: n[1] - Double(4 - k))
              try? await Task.sleep(for: .milliseconds(30))
              await Self.pump()
            }
            self.model?.endGesture()
            await Self.pump()
          case "toggle" where step.count >= 3:
            self.model?.flip(step[2], row: Int(n[0]))
          case "undo":
            await Self.pump()
            #if os(macOS)
              self.window?.undoManager?.undo()
            #endif
            await Self.pump()
          case "import" where step.count >= 2:
            self.model?.importData(step.dropFirst().map { URL(fileURLWithPath: $0) })
            await Self.pump()
          case "save" where step.count >= 2:
            try? self.model?.encoded()?.write(to: URL(fileURLWithPath: step[1]))
          case "load" where step.count >= 2:
            if let bytes = try? Data(contentsOf: URL(fileURLWithPath: step[1])) { self.model?.load(bytes) }
            await Self.pump()
          case "ungrouped":
            self.model?.undoManager = nil
          case "ask" where step.count >= 3:
            guard let model = self.model else { continue }
            let access = GraphAccess()
            access.rows = model.rows
            access.apply = model.edit
            access.model = model
            let rest = Array(step.dropFirst(3))
            let rows = rest.joined(separator: " ").split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            let m = rest.map { Double($0) ?? 0 }
            var answer = "can't read the tool"
            switch step[2] {
            case "get": answer = await access.graph()
            case "check": answer = await access.check(rows)
            case "set": answer = await access.set(rows)
            case "view" where m.count >= 4:
              answer = await access.moveView(["x": [m[0], m[1]], "y": [m[2], m[3]]], seconds: m.count > 4 ? m[4] : 0.3)
            case "camera" where m.count >= 3:
              answer = await access.moveView(
                ["theta": m[0], "phi": m[1], "radius": m[2]], seconds: m.count > 3 ? m[3] : 0.3)
            case "slider" where rest.count >= 2:
              let seconds = m.count > 2 ? m[2] : 0.3
              answer = await access.animateSlider(rest[0], to: m[1], from: nil, seconds: seconds)
              try? await Task.sleep(for: .seconds(seconds + 0.2))
            default: break
            }
            let name = step[1]
            let url =
              name.hasPrefix("/")
              ? URL(fileURLWithPath: "\(name).txt")
              : URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("\(name).txt")
            try? answer.write(to: url, atomically: true, encoding: .utf8)
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
            let hover = "hover \(self.viewport.hover?.text ?? "-")"
            // (As the editor shows them: with what drawing the rows found.)
            let status = (self.model?.shown ?? []).enumerated().map { k, row in
              let toggles = (row.toggles ?? []).map { "\($0.id)=\($0.on ? "on" : "off")" }.joined(separator: ",")
              let slider = row.slider.map { " slider \($0.min)..\($0.max) step \($0.step) at \($0.value)" } ?? ""
              let needs = row.needsFile.map { " | needs \($0)\(row.opensFile == true ? " [asks]" : "")" } ?? ""
              return "row \(k): error \(row.error ?? "-") | unsupported \(row.unsupported ?? "-") | "
                + "info \(row.info ?? "-") | toggles \(toggles.isEmpty ? "-" : toggles)\(slider)\(needs)"
            }
            let data = (self.model?.dataNotices() ?? []).map { "data \($0)" }
            let seeds = self.viewport.states.enumerated().filter { !$0.element.seeds.isEmpty }.map { k, state in
              "seeds \(k): " + state.seeds.map { "\($0.x),\($0.y)" }.joined(separator: " ")
            }
            try? ([size, hover] + lines + seeds + status + data).joined(separator: "\n")
              .write(to: file("txt"), atomically: true, encoding: .utf8)
          default:
            print("EQUATION_SCRIPT: can't read step \(step.joined(separator: " "))")
          }
        }
      }
    }

    /// Let the application take an event, which ends the undo group of what
    /// was registered since the last one.
    private static func pump() async {
      #if os(macOS)
        if let event = NSEvent.otherEvent(
          with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
          subtype: 0, data1: 0, data2: 0)
        {
          NSApp.postEvent(event, atStart: false)
        }
        try? await Task.sleep(for: .milliseconds(30))
      #endif
    }

    /// The frame the view shows now, drawn again offscreen with its overlay
    /// and written as a PNG.
    private func writeShot(to url: URL) {
      guard let image = snapshot(),
        let out = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
      else { return }
      CGImageDestinationAddImage(out, image, nil)
      CGImageDestinationFinalize(out)
      print("EQUATION_SCRIPT: wrote \(url.path)")
    }
  }
#endif
