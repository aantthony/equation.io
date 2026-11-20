import Foundation
import FoundationModels

// The chat's model, instructions and tools, without its views: the app
// (Chat.swift) and the eval runner (apple/evals/Runner.swift) both compile
// this file, so the evals measure exactly what the app asks.

/// What the editor shows of each row, as the analysis has it (`GraphAnalysis`,
/// in GraphView.swift; in the evals, the service's word for the same).
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
  /// Why the app does not draw a row the site does: not an error, and not
  /// the model's to fix. (Absent from the evals' service, which reads everything.)
  var unsupported: String?
  /// The display toggles the row offers, as the site's buttons under it
  /// (web/main.ts `rowToggles`, `makeLevelsBtn`).
  var toggles: [Toggle]?
  /// The row reads a data file that is not in this document: what it says
  /// of the file. Not an error — the row draws once the file is given.
  var needsFile: String?
  /// The row is the one that names a data file, `p = open("a.csv", …)`:
  /// where a missing file is asked for.
  var opensFile: Bool?

  struct Toggle: Decodable, Equatable {
    /// levels, sums, streamlines or arrows.
    var id: String
    var label: String
    var help: String
    var on: Bool
  }

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
  /// the device: it passes 77% of the evals to the device's 49%
  /// (apple/evals/RESULTS.md). It needs the target's
  /// com.apple.developer.private-cloud-compute entitlement (project.yml);
  /// where it isn't available, the chat falls back to the model on the device.
  static let usePrivateCloudCompute = true

  /// The server model, when the app uses it and it can be reached from here.
  private static var server: PrivateCloudComputeLanguageModel? {
    guard usePrivateCloudCompute else { return nil }
    let server = PrivateCloudComputeLanguageModel()
    return server.isAvailable ? server : nil
  }

  static func make() -> any LanguageModel {
    server ?? SystemLanguageModel.default
  }

  /// Why the chat can't run on this device, in words for the person using it.
  static var unavailableReason: String? {
    if server != nil { return nil }
    return switch SystemLanguageModel.default.availability {
    case .available: nil
    case .unavailable(.deviceNotEligible): "This device can't run Apple Intelligence, which Ask needs."
    case .unavailable(.appleIntelligenceNotEnabled): "Turn on Apple Intelligence in Settings to use Ask."
    case .unavailable(.modelNotReady): "Apple Intelligence is still getting ready. Try again in a little while."
    case .unavailable: "Ask isn't available on this device."
    }
  }

  // The instructions (instructions, referenceInstructions) are in
  // Instructions.swift, generated from lib/assistant-instructions.ts.

  /// How every reply is generated, in the app and the evals: greedy, the
  /// likeliest token each time, so a request gets the same answer each time.
  static let options = GenerationOptions(samplingMode: .greedy)

  /// The chat's tools, over whatever graph they act on.
  static func tools(_ graph: any GraphTools) -> [any Tool] {
    [
      GetGraph(access: graph), SetGraph(access: graph), MoveView(access: graph),
      AnimateSlider(access: graph), Check(access: graph), ListKinds(access: graph),
      KindExamples(access: graph), ShapeLookup(access: graph), SearchFunctions(access: graph),
      FunctionDoc(access: graph),
    ]
  }

  /// Each request as the model sees it: the graph's rows now, then the request.
  static func prompt(_ request: String, rows: [String], status: [RowStatus]) -> String {
    "The graph's rows now:\n\(report(rows, status))\n\n\(request)"
  }

  /// After a reply, one message asking the model to fix the rows that have an
  /// error, naming each; nil when no row has one. Errors only: a warning (a
  /// definition nothing uses yet) can be meant, and an error never is. The
  /// on-device model claims success over broken rows ("I drew a circle
  /// centered at (4, 1)" over an error), so the app asks once, in the same
  /// session (Chat.swift), as do the evals (apple/evals/Runner.swift).
  static func followUp(rows: [String], status: [RowStatus]) -> String? {
    let problems = rows.indices.compactMap { k -> String? in
      guard k < status.count, let error = status[k].error else { return nil }
      return "Row \(k + 1), `\(rows[k])`: \(error)"
    }
    guard !problems.isEmpty else { return nil }
    let one = problems.count == 1
    return (["The graph has \(one ? "an error" : "errors"):"] + problems + [
      "Fix \(one ? "it" : "them") with set_graph, then reply."
    ]).joined(separator: "\n")
  }

  /// Shown under a reply when a row still has an error after the follow-up.
  static let stillAnError = "The graph still has an error."

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

/// What the chat's tools do to a graph: in the app, the open document and
/// its Metal view (GraphAccess, in Chat.swift); in the evals (apple/evals),
/// a service running the site's analyzer. Each answers with JSON text, as
/// the site's voice tools did (its voice mode, since removed).
@MainActor protocol GraphTools: AnyObject, Sendable {
  /// get_graph, as the site's voice mode had it: every row's status and meaning, and the window or camera.
  func graph() async -> String
  /// Replace the rows, and read the graph back once it is drawn.
  func set(_ rows: [String]) async -> String
  func moveView(_ target: [String: Any], seconds: Double) async -> String
  func animateSlider(_ name: String, to: Double, from: Double?, seconds: Double) async -> String
  /// What rows would draw, without drawing them (lib/assistant-tools.ts checkRows).
  func check(_ rows: [String]) async -> String
  // What the language has (lib/assistant-tools.ts), as text.
  func listKinds() async -> String
  func kindExamples(_ kind: String) async -> String
  func shape(_ name: String) async -> String
  func searchFunctions(_ query: String) async -> String
  func functionDoc(_ name: String) async -> String
}

/// Seconds a tool may take: long enough to see, short enough that a slip
/// can't hold the view for minutes (as the site's voice mode held it).
private func seconds(_ value: Double?, default fallback: Double) -> Double {
  guard let value, value.isFinite else { return fallback }
  return min(30, max(0, value))
}

/// A row as the model wrote it, tidied: no surrounding whitespace, and no
/// trailing comma (it often ends a row as if it were an item in a list).
private func tidy(_ row: String) -> String {
  var row = row.trimmingCharacters(in: .whitespacesAndNewlines)
  while row.hasSuffix(",") { row = row.dropLast().trimmingCharacters(in: .whitespacesAndNewlines) }
  return row
}

// MARK: - Tools (first written for the site's voice mode, since removed)

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
    let rows = arguments.equations.map(tidy).filter { !$0.isEmpty }
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
    await access.check(arguments.equations.map(tidy))
  }
}

struct ListKinds: Tool {
  let access: any GraphTools
  let name = "list_kinds"
  let description = """
    List every kind of shape a row can draw (curve, region, surface, solid, \
    point, …), each with its smallest form. Read it before writing a kind of \
    row you haven't written in this conversation.
    """

  @Generable
  struct Arguments {
    @Guide(description: "Why you are reading it, in a few words.")
    var reason: String
  }

  func call(arguments: Arguments) async throws -> String { await access.listKinds() }
}

struct KindExamples: Tool {
  let access: any GraphTools
  let name = "kind_examples"
  let description = """
    Worked examples of one kind from list_kinds: what it draws, its smallest \
    form, and whole graphs that draw it, one entry per row.
    """

  @Generable
  struct Arguments {
    @Guide(description: "A kind from the Kinds list in the instructions.")
    var kind: String
  }

  func call(arguments: Arguments) async throws -> String { await access.kindExamples(arguments.kind) }
}

/// shape: not `Shape`, which SwiftUI's protocol is in the app.
struct ShapeLookup: Tool {
  let access: any GraphTools
  let name = "shape"
  let description = """
    The equation of a named curve or surface (cardioid, hyperboloid, torus, …), \
    in this language's syntax, with its parameters. It draws nothing: set_graph draws.
    """

  @Generable
  struct Arguments {
    // No example value: an example in an argument's description gets copied (apple/evals/RESULTS.md).
    @Guide(description: "The shape's name, as the request gives it.")
    var name: String
  }

  func call(arguments: Arguments) async throws -> String { await access.shape(arguments.name) }
}

struct SearchFunctions: Tool {
  let access: any GraphTools
  let name = "search_functions"
  let description = """
    Find built-in functions by what they do. Returns each match's signature \
    and a line on what it does.
    """

  @Generable
  struct Arguments {
    @Guide(description: "A few words saying what the function does, e.g. \"convex hull\", \"inverse sine\".")
    var query: String
  }

  func call(arguments: Arguments) async throws -> String { await access.searchFunctions(arguments.query) }
}

struct FunctionDoc: Tool {
  let access: any GraphTools
  let name = "function_doc"
  let description = """
    Look up one built-in function by name: its signature, what it does, and \
    examples that use it. Use it before calling a function you aren't sure of.
    """

  @Generable
  struct Arguments {
    @Guide(description: "The function's name, e.g. \"hull\".")
    var name: String
  }

  func call(arguments: Arguments) async throws -> String { await access.functionDoc(arguments.name) }
}
