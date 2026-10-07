import FoundationModels
import SwiftUI

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
}

// MARK: - The graph, as the chat sees it

/// The open graph, for the chat's tools.
@MainActor final class GraphAccess {
  var rows: () -> [String] = { [] }
  var apply: ([String]) -> Void = { _ in }
  weak var model: GraphModel?

  /// The voice prototype's get_graph: every row's status and meaning, and the window or camera.
  func graph() async -> String {
    await model?.ask("return window.equationApp.graph()") ?? #"{"error":"the graph isn't ready"}"#
  }

  /// Change the graph, wait for the renderer to draw it, and read it back.
  func set(_ rows: [String]) async -> String {
    apply(rows)
    _ = await model?.status(after: rows)
    return await graph()
  }

  func moveView(_ target: [String: Any], seconds: Double) async -> String {
    return await model?.ask(
      "return window.equationApp.moveView(target, seconds)", ["target": target, "seconds": seconds])
      ?? #"{"error":"the graph isn't ready"}"#
  }

  func animateSlider(_ name: String, to: Double, from: Double?, seconds: Double) async -> String {
    var arguments: [String: Any] = ["name": name, "to": to, "seconds": seconds]
    if let from { arguments["from"] = from }
    let body =
      from == nil
      ? "return window.equationApp.animateSlider(name, to, seconds)"
      : "return window.equationApp.animateSlider(name, to, seconds, from)"
    return await model?.ask(body, arguments) ?? #"{"error":"the graph isn't ready"}"#
  }

  func readSyntax(_ query: String) async -> String {
    return await model?.ask("return window.equationApp.readSyntax(query)", ["query": query])
      ?? #"{"error":"the reference isn't ready"}"#
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

/// Seconds a tool may take: long enough to see, short enough that a slip
/// can't hold the view for minutes (as in web/voice.ts).
private func seconds(_ value: Double?, default fallback: Double) -> Double {
  guard let value, value.isFinite else { return fallback }
  return min(30, max(0, value))
}

// MARK: - Tools (the voice prototype's, lib/voice-agent.ts)

struct GetGraph: Tool {
  let access: GraphAccess
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
  let access: GraphAccess
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
  let access: GraphAccess
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
  let access: GraphAccess
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

struct ReadSyntax: Tool {
  let access: GraphAccess
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

// MARK: - The conversation

@MainActor @Observable
final class GraphChat {
  struct Message: Identifiable {
    enum Role { case user, assistant, note }
    let id = UUID()
    var role: Role
    var text: String
  }

  private(set) var messages: [Message] = []
  private(set) var isResponding = false
  /// "Thinking…" until the reply starts. Never what a tool is doing: the
  /// graph moving, changing or animating says that itself.
  private(set) var activity: String?
  /// The graph as it was before the last reply changed it, for Undo.
  private(set) var undoRows: [String]?
  /// Whether the reply over the graph is showing.
  var showsReply = false

  @ObservationIgnored let access = GraphAccess()
  @ObservationIgnored private var session: LanguageModelSession?
  @ObservationIgnored private var hideReply: Task<Void, Never>?

  /// The request and reply the graph shows: the last exchange.
  var lastRequest: String? { messages.last { $0.role == .user }?.text }
  var lastReply: Message? { messages.last.flatMap { $0.role == .user ? nil : $0 } }

  func send(_ text: String) {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !isResponding else { return }
    Task { await respond(to: text) }
  }

  private func respond(to text: String) async {
    messages.append(Message(role: .user, text: text))
    isResponding = true
    activity = "Thinking…"
    showReply(stay: true)
    defer {
      isResponding = false
      activity = nil
      showReply(stay: false)
    }
    let before = access.rows()
    let session =
      self.session
      ?? LanguageModelSession(
        model: ChatModel.make(),
        tools: [
          GetGraph(access: access), SetGraph(access: access), MoveView(access: access),
          AnimateSlider(access: access), ReadSyntax(access: access),
        ],
        instructions: ChatModel.instructions)
    self.session = session
    let prompt = "The graph's rows now:\n\(GraphAccess.report(before, access.model?.status ?? []))\n\n\(text)"
    messages.append(Message(role: .assistant, text: ""))
    let reply = messages.count - 1
    do {
      for try await snapshot in session.streamResponse(to: prompt) {
        messages[reply].text = snapshot.content
        if !snapshot.content.isEmpty { activity = nil }
      }
    } catch LanguageModelError.contextSizeExceeded {
      self.session = nil
      messages[reply] = Message(role: .note, text: "That conversation got too long, so it starts afresh. Ask again.")
    } catch {
      messages[reply] = Message(role: .note, text: error.localizedDescription)
    }
    if messages[reply].role == .assistant && messages[reply].text.isEmpty { messages.remove(at: reply) }
    if access.rows() != before { undoRows = before }
  }

  /// Show the reply over the graph: for good while `stay`, else for a few
  /// seconds from now.
  func showReply(stay: Bool) {
    hideReply?.cancel()
    showsReply = true
    guard !stay else { return }
    hideReply = Task { [weak self] in
      try? await Task.sleep(for: .seconds(8))
      guard !Task.isCancelled else { return }
      withAnimation { self?.showsReply = false }
    }
  }

  func dismissReply() {
    hideReply?.cancel()
    withAnimation { showsReply = false }
  }

  /// Put the graph back as it was before the last reply changed it.
  func undo() {
    guard let rows = undoRows else { return }
    access.apply(rows)
    undoRows = nil
    messages.append(Message(role: .note, text: "Put the graph back as it was."))
    showReply(stay: false)
  }

  /// Forget the conversation (the graph stays as it is).
  func reset() {
    session = nil
    messages = []
    undoRows = nil
    dismissReply()
  }
}

// MARK: - Views

/// Ask, over the graph: a glass field to type a request into, and above it
/// the latest thing the model said (or is doing). Clicking that, or the
/// chevron, opens the whole conversation.
struct ChatOverlay: View {
  var chat: GraphChat
  /// Bumped to put the cursor in the field (the toolbar's Ask, ⌘K).
  var focusRequest: Int
  /// Where the overlay sits: the conversation opens away from that edge.
  var edge: VerticalEdge = .bottom

  @State private var draft = ""
  @State private var expanded = false
  @FocusState private var focused: Bool

  var body: some View {
    VStack(spacing: 8) {
      if edge == .top { field }
      if expanded {
        conversation
      } else if chat.showsReply {
        latest
      }
      if edge == .bottom { field }
    }
    .frame(maxWidth: 560)
    .padding(.horizontal, 16)
    .padding(edge == .bottom ? .bottom : .top, 14)
    .animation(.snappy, value: expanded)
    .animation(.snappy, value: chat.showsReply)
    .onChange(of: focusRequest) { focused = true }
    #if os(macOS)
      .onExitCommand {
        if expanded { expanded = false } else { focused = false }
      }
    #endif
  }

  // MARK: The field

  private var field: some View {
    HStack(spacing: 10) {
      Image(systemName: "sparkles")
        .foregroundStyle(.tint)
      TextField(placeholder, text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...5)
        .focused($focused)
        .onSubmit(send)
        .disabled(ChatModel.unavailableReason != nil)
      if chat.isResponding {
        ProgressView().controlSize(.small)
      } else if !draft.trimmingCharacters(in: .whitespaces).isEmpty {
        Button("Send", systemImage: "arrow.up.circle.fill", action: send)
          .labelStyle(.iconOnly)
          .font(.title2)
          .buttonStyle(.borderless)
          .keyboardShortcut(.defaultAction)
      }
      if !chat.messages.isEmpty {
        Button(expanded ? "Hide Conversation" : "Show Conversation", systemImage: "chevron.up") {
          expanded.toggle()
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .rotationEffect(.degrees((expanded ? 180 : 0) + (edge == .top ? 180 : 0)))
        .foregroundStyle(.secondary)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
  }

  private var placeholder: String {
    ChatModel.unavailableReason ?? "Ask to change the graph…"
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !chat.isResponding else { return }
    chat.send(text)
    draft = ""
  }

  // MARK: The latest message

  /// What the model is doing, or the last thing it said; a click opens the
  /// conversation.
  private var latest: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      if let activity = chat.activity {
        ProgressView().controlSize(.small)
        Text(activity).foregroundStyle(.secondary)
      } else if let message = chat.lastReply {
        Image(systemName: message.role == .note ? "exclamationmark.circle" : "sparkles")
          .foregroundStyle(message.role == .note ? Color.secondary : Color.accentColor)
        Text(message.text)
          .lineLimit(4)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
      if chat.undoRows != nil && !chat.isResponding {
        Button("Undo", systemImage: "arrow.uturn.backward") { chat.undo() }
          .buttonStyle(.borderless)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .glassEffect(.regular, in: .rect(cornerRadius: 18))
    .contentShape(.rect)
    .onTapGesture { expanded = true }
    .transition(.move(edge: edge == .bottom ? .bottom : .top).combined(with: .opacity))
  }

  // MARK: The conversation

  private var conversation: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Ask").font(.headline)
        Spacer()
        if chat.undoRows != nil && !chat.isResponding {
          Button("Undo Change", systemImage: "arrow.uturn.backward") { chat.undo() }
        }
        Button("New Conversation", systemImage: "square.and.pencil") {
          chat.reset()
          expanded = false
        }
        .labelStyle(.iconOnly)
      }
      .buttonStyle(.borderless)
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      Divider()
      ScrollViewReader { scroll in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(chat.messages) { message in
              ChatBubble(message: message).id(message.id)
            }
            if let activity = chat.activity {
              HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(activity).foregroundStyle(.secondary)
              }
            }
          }
          .padding(16)
        }
        .defaultScrollAnchor(.bottom)
        .onChange(of: chat.messages.last?.text) {
          if let last = chat.messages.last { scroll.scrollTo(last.id, anchor: .bottom) }
        }
      }
    }
    .frame(maxHeight: 360)
    .glassEffect(.regular, in: .rect(cornerRadius: 22))
    .transition(.move(edge: edge == .bottom ? .bottom : .top).combined(with: .opacity))
  }
}

private struct ChatBubble: View {
  var message: GraphChat.Message

  var body: some View {
    switch message.role {
    case .user:
      Text(message.text)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.tint.opacity(0.15), in: .rect(cornerRadius: 16))
        .frame(maxWidth: .infinity, alignment: .trailing)
    case .assistant:
      Text(message.text).textSelection(.enabled)
    case .note:
      Text(message.text).font(.footnote).foregroundStyle(.secondary)
    }
  }
}
