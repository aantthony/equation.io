import Foundation
import FoundationModels

// The chat's model, instructions and tools, without its views: the app
// (Chat.swift) and the eval runner (apple/evals/Runner.swift) both compile
// this file, so the evals measure exactly what the app asks.

/// What the renderer reports about each row (web/native-app.ts `NativeRowStatus`).
struct RowStatus: Decodable, Equatable {
  /// 0–1 RGB, or nil when the row draws nothing in a color of its own.
  var color: [Double]?
  var error: String?
  var info: String?
  /// A `# heading` row.
  var comment: Bool
  /// A viewport row, written by panning.
  var view: Bool
  /// A `---` row, splitting the graph into panels.
  var divider: Bool
  /// Where the trailing `# note` starts, in UTF-16 offsets.
  var note: Int?
  /// Syntax colors over the row's text, in UTF-16 offsets.
  var spans: [Span]
  var slider: Slider?

  struct Span: Decodable, Equatable {
    var start: Int
    var end: Int
    /// num, str, fn, const, coord, name, unbound or op (lib/highlight.ts).
    var cls: String
  }

  struct Slider: Decodable, Equatable {
    var min: Double
    var max: Double
    var step: Double
    var value: Double
  }
}

// MARK: - The model

/// Which language model the chat talks to.
enum ChatModel {
  /// Apple's server model on Private Cloud Compute, instead of the one on
  /// the device. Needs the app's com.apple.developer.private-cloud-compute
  /// entitlement (requested on the developer website, then added to the
  /// target): turn this on once it is granted.
  static let usePrivateCloudCompute = false

  static func make() -> any LanguageModel {
    if usePrivateCloudCompute {
      let server = PrivateCloudComputeLanguageModel()
      if server.isAvailable { return server }
    }
    return SystemLanguageModel.default
  }

  /// Why the chat can't run on this device, in words for the person using it.
  static var unavailableReason: String? {
    switch SystemLanguageModel.default.availability {
    case .available: nil
    case .unavailable(.deviceNotEligible): "This device can't run Apple Intelligence, which Ask needs."
    case .unavailable(.appleIntelligenceNotEnabled): "Turn on Apple Intelligence in Settings to use Ask."
    case .unavailable(.modelNotReady): "Apple Intelligence is still getting ready. Try again in a little while."
    case .unavailable: "Ask isn't available on this device."
    }
  }

  /// The voice prototype's tutor (lib/voice-agent.ts), for a typed request
  /// whose reply shows briefly over the graph: show, don't tell.
  static let instructions = """
    You are a maths tutor inside Equation.io, a graphing calculator. The user \
    types a request; you change and show things on the graph with tools, then \
    reply in one or two short sentences, which appear briefly over the graph. \
    Teach by showing: draw it, frame it, animate it.

    How the graph works:
    - The graph is a list of rows. Each message starts with the rows as they are \
    now, with any row's error. Verified forms:
      - Curves and regions: "y = sin(x)", "x^2 + y^2 = 4", "y < x^2" (shaded \
    region), "z = x^2 - y^2" (3D surface).
      - Sliders: "a = 2" makes a slider; then "y = a sin(x)" uses it.
      - Functions: "f(x) = x^3 - x" only DEFINES f and draws nothing; add \
    "y = f(x)" to draw it, and "y = d/dx f(x)" for its derivative.
      - Areas: "int[0..pi] sin(x) dx" shades the area under sin from 0 to pi \
    and shows its value.
      - Points: "A = (1, 2)" is a draggable named point.
      - Parametric curves use u, which runs from 0 to 1 (not t): \
    "(2cos(2pi u), 2sin(2pi u))" is a circle of radius 2.
      - Polar curves r = f(theta): write them parametrically with \
    theta = 2pi u: the rose r = sin(4 theta) is "(sin(8pi u) cos(2pi u), \
    sin(8pi u) sin(2pi u))". Never write a bare "r = …" row.
      - t is time in seconds and makes things move: "y = sin(x - t)" is a \
    travelling wave.
    - Implicit multiplication works: "2x", "a sin(x)". Use ^ for powers, \
    sqrt(), abs(), ln(), exp(), pi.
    - Labels: label((2, 4), "they cross here"). Colors: end a row with a hex \
    color, e.g. "y = x^2 #e24".
    - Don't name anything i, e, pi, tau or d: they are taken.
    - Anything beyond these forms: call read_syntax first. Never invent \
    function names.

    Changing the graph:
    - set_graph replaces the graph: pass the COMPLETE list of rows. Change the \
    row a request is about rather than adding a near copy, and keep every other \
    row exactly as it was. "Make it move" turns y = sin(x) into y = sin(x - t); \
    "a slider for the amplitude" turns it into A = 1 and y = A sin(x).
    - set_graph and get_graph return each row's status and meaning (what the \
    row actually is). Check every meaning matches what you meant. If a row has \
    an error or a warning, fix it and call set_graph again before answering. \
    Never say you drew something the result doesn't show.

    Showing:
    - move_view frames what matters: zoom into an intersection, out to see end \
    behaviour. In 3D, a slow spin (0.3) shows a shape from every side.
    - animate_slider glides a slider so the change can be seen: to show what a \
    does, first add the slider row with set_graph, then animate it over 3 to 6 \
    seconds.
    - Order matters: change the graph first, then frame and animate what it drew.

    Replies: one or two short sentences saying what you drew, not the syntax. \
    If a request is ambiguous, draw your best guess and say what you chose.
    """
  /// The chat's tools, over whatever graph they act on.
  static func tools(_ graph: any GraphTools) -> [any Tool] {
    [
      GetGraph(access: graph), SetGraph(access: graph), MoveView(access: graph),
      AnimateSlider(access: graph), Check(access: graph), ReadSyntax(access: graph),
    ]
  }

  /// Each request as the model sees it: the graph's rows now, then the request.
  static func prompt(_ request: String, rows: [String], status: [RowStatus]) -> String {
    "The graph's rows now:\n\(report(rows, status))\n\n\(request)"
  }

  /// The rows, numbered, each with its error or readout: what each message starts with.
  static func report(_ rows: [String], _ status: [RowStatus]) -> String {
    if rows.isEmpty { return "The graph is empty." }
    return rows.enumerated().map { k, row in
      var line = "\(k + 1). \(row)"
      if k < status.count {
        if let error = status[k].error {
          line += "   <- ERROR: \(error)"
        } else if let info = status[k].info {
          line += "   (= \(info))"
        }
      }
      return line
    }.joined(separator: "\n")
  }
}

// MARK: - The graph, as the chat's tools see it

/// What the chat's tools do to a graph: in the app, the renderer
/// (GraphAccess, in Chat.swift); in the evals (apple/evals), a service
/// running the same analyzer. Each answers as the renderer's bridge
/// does, with JSON text.
@MainActor protocol GraphTools: AnyObject, Sendable {
  /// The voice prototype's get_graph: every row's status and meaning, and the window or camera.
  func graph() async -> String
  /// Replace the rows, and read the graph back once it is drawn.
  func set(_ rows: [String]) async -> String
  func moveView(_ target: [String: Any], seconds: Double) async -> String
  func animateSlider(_ name: String, to: Double, from: Double?, seconds: Double) async -> String
  /// What rows would draw, without drawing them (lib/assistant-tools.ts checkRows).
  func check(_ rows: [String]) async -> String
  func readSyntax(_ query: String) async -> String
}

/// Seconds a tool may take: long enough to see, short enough that a slip
/// can't hold the view for minutes (as in web/voice.ts).
private func seconds(_ value: Double?, default fallback: Double) -> Double {
  guard let value, value.isFinite else { return fallback }
  return min(30, max(0, value))
}

// MARK: - Tools (the voice prototype's, lib/voice-agent.ts)

struct GetGraph: Tool {
  let access: any GraphTools
  let name = "get_graph"
  let description = """
    Read the graph: the visible window (2D) or camera (3D), and for every row \
    its text, status, meaning, color, readout value, and (2D curves) axis \
    intercepts in view.
    """

  @Generable
  struct Arguments {
    @Guide(description: "Why you are reading it, in a few words.")
    var reason: String
  }

  func call(arguments: Arguments) async throws -> String { await access.graph() }
}

struct SetGraph: Tool {
  let access: any GraphTools
  let name = "set_graph"
  let description = """
    Replace the whole graph. Pass every row that should be on screen, \
    including unchanged ones. Returns the new graph as get_graph does.
    """

  @Generable
  struct Arguments {
    @Guide(description: "One equation or definition per entry, e.g. [\"a = 2\", \"y = a sin(x)\"].")
    var equations: [String]
  }

  func call(arguments: Arguments) async throws -> String {
    let rows = arguments.equations.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    return await access.set(rows)
  }
}

struct MoveView: Tool {
  let access: any GraphTools
  let name = "move_view"
  let description = """
    Smoothly pan and zoom to a new framing. In 2D give x and/or y ranges. In 3D \
    give any of theta, phi, radius, target, and spin to keep the camera orbiting.
    """

  @Generable
  struct Arguments {
    @Guide(description: "2D: the x range to show, [low, high].")
    var x: [Double]?
    @Guide(description: "2D: the y range to show, [low, high].")
    var y: [Double]?
    @Guide(description: "3D: azimuth in radians.")
    var theta: Double?
    @Guide(description: "3D: elevation in radians, -pi/2 to pi/2.")
    var phi: Double?
    @Guide(description: "3D: distance from the target.")
    var radius: Double?
    @Guide(description: "3D: the point looked at, [x, y, z].")
    var target: [Double]?
    @Guide(description: "3D: keep orbiting at this many radians per second afterwards (0.3 is slow; 0 stops).")
    var spin: Double?
    @Guide(description: "How long the move takes. Default 1.5.")
    var seconds: Double?
  }

  func call(arguments a: Arguments) async throws -> String {
    var target: [String: Any] = [:]
    if let x = a.x, x.count == 2 { target["x"] = x }
    if let y = a.y, y.count == 2 { target["y"] = y }
    if let theta = a.theta { target["theta"] = theta }
    if let phi = a.phi { target["phi"] = phi }
    if let radius = a.radius, radius > 0 { target["radius"] = radius }
    if let point = a.target, point.count == 3 { target["target"] = point }
    if let spin = a.spin { target["spin"] = min(10, max(-10, spin)) }
    return await access.moveView(target, seconds: seconds(a.seconds, default: 1.5))
  }
}

struct AnimateSlider: Tool {
  let access: any GraphTools
  let name = "animate_slider"
  let description = """
    Glide a slider (a constant row like "a = 2") to a new value at a steady \
    rate, so the change can be watched. The final value is saved in the row.
    """

  @Generable
  struct Arguments {
    @Guide(description: "The slider's name, e.g. \"a\".")
    var name: String
    var to: Double
    @Guide(description: "Jump here first. Default: the current value.")
    var from: Double?
    @Guide(description: "Default 3.")
    var seconds: Double?
  }

  func call(arguments a: Arguments) async throws -> String {
    await access.animateSlider(a.name, to: a.to, from: a.from, seconds: seconds(a.seconds, default: 3))
  }
}

struct Check: Tool {
  let access: any GraphTools
  let name = "check"
  let description = """
    Read rows without drawing them: what each row would be (its kind and \
    meaning), its value, and any error or warning. Pass the complete list, as \
    for set_graph. The graph doesn't change.
    """

  @Generable
  struct Arguments {
    @Guide(description: "One equation or definition per entry, e.g. [\"a = 2\", \"y = a sin(x)\"].")
    var equations: [String]
  }

  func call(arguments: Arguments) async throws -> String {
    await access.check(arguments.equations.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) })
  }
}

struct ReadSyntax: Tool {
  let access: any GraphTools
  let name = "read_syntax"
  let description = """
    Look up Equation.io syntax in its reference manual. Returns the matching \
    entries with examples. Use it before writing any form not in your \
    instructions, and after any row error.
    """

  @Generable
  struct Arguments {
    @Guide(description: "A few words naming what you want to write, e.g. \"parametric surface\", \"vector field\".")
    var query: String
  }

  func call(arguments: Arguments) async throws -> String { await access.readSyntax(arguments.query) }
}
