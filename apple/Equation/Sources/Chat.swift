import EquationAssist
import EquationCore
import EquationRender
import FoundationModels
import SwiftUI

// MARK: - The graph, as the chat sees it

/// The open graph, for the chat's tools.
@MainActor final class GraphAccess: GraphTools {
  var rows: () -> [String] = { [] }
  var apply: ([String]) -> Void = { _ in }
  weak var model: GraphModel?

  /// Sliders gliding for animate_slider, by the slider's name.
  private var glides: [String: Task<Void, Never>] = [:]

  /// The lookups (EquationAssist, lib/assistant-tools.ts ported), over the
  /// data `pnpm app:data` writes and the app bundles; read once.
  private static let lookups: AssistantLookups? = {
    guard let assistant = try? Data(contentsOf: AppData.url("assistant")),
      let language = try? Data(contentsOf: AppData.url("language"))
    else { return nil }
    return try? AssistantLookups(assistant: assistant, language: language)
  }()
  private static let noLookups = #"{"error":"the app's reference is missing from this build"}"#
  private static let notReady = #"{"error":"the graph isn't ready"}"#

  /// lib/assistant-tools.ts `KIND_MEANINGS`, as `pnpm app:data` bundles it (language.json).
  private static let kindMeanings: [String: String] = {
    struct Language: Decodable { var kindMeanings: [String: String] }
    guard let data = try? Data(contentsOf: AppData.url("language")) else { return [:] }
    return (try? JSONDecoder().decode(Language.self, from: data).kindMeanings) ?? [:]
  }()

  /// get_graph, as the site's voice mode had it: every row's status and meaning, and the window or camera.
  func graph() async -> String {
    guard let model else { return Self.notReady }
    return Self.state(rows: rows(), theme: model.theme, framing: model.metal?.framing)
  }

  /// Change the graph, and read it back.
  func set(_ rows: [String]) async -> String {
    apply(rows)
    guard let model else { return Self.notReady }
    // The view takes the new rows on the next turn of the run loop: its framing is the new graph's then.
    await Task.yield()
    return Self.state(rows: rows, theme: model.theme, framing: model.metal?.framing)
  }

  /// move_view (the site's former voice mode's `movePanelView`): ease the first panel's window
  /// or camera to a new framing, answering once it is there.
  func moveView(_ target: [String: Any], seconds: Double) async -> String {
    guard let canvas = model?.metal, let framing = canvas.framing else { return Self.notReady }
    let number = { (key: String) in (target[key] as? NSNumber)?.doubleValue }
    let spin = number("spin")
    guard case .camera = framing else {
      let pair = { (key: String) -> [Double]? in
        guard let pair = (target[key] as? [Any])?.compactMap({ ($0 as? NSNumber)?.doubleValue }), pair.count == 2
        else { return nil }
        return pair
      }
      if spin != nil { return #"{"error":"spin turns the 3D camera; this graph is 2D"}"# }
      let (x, y) = (pair("x"), pair("y"))
      if x == nil && y == nil { return #"{"error":"the graph is 2D: give x and/or y ranges"}"# }
      if [x, y].contains(where: { $0.map { !($0[1] > $0[0]) } ?? false }) {
        return #"{"error":"each range must be [low, high] with high > low"}"#
      }
      guard await canvas.glide(x: x.map { ($0[0], $0[1]) }, y: y.map { ($0[0], $0[1]) }, seconds: seconds),
        case .window(let shown, let up)? = canvas.framing
      else { return Self.stopped }
      return "{\"x\":\(Self.list(shown)),\"y\":\(Self.list(up)),\"seconds\":\(JS.string(seconds))}"
    }
    var move = CameraMove(theta: number("theta"), phi: number("phi"), radius: number("radius"))
    if let point = (target["target"] as? [Any])?.compactMap({ ($0 as? NSNumber)?.doubleValue }), point.count == 3 {
      move.target = SIMD3(point[0], point[1], point[2])
    }
    if move.isEmpty {
      guard let spin else { return #"{"error":"the graph is 3D: give theta, phi, radius, target and/or spin"}"# }
      canvas.setSpin(spin)
      return "{\"spin\":\(JS.string(spin)),\"note\":\"saved in the camera row\"}"
    }
    guard await canvas.glide(camera: move, seconds: seconds) else { return Self.stopped }
    // Arrive, then ease into the spin: the camera never jerks from rest to full speed.
    if let spin { canvas.setSpin(spin) }
    guard case .camera(let camera, let turning)? = canvas.framing else { return Self.notReady }
    let note = spin != nil ? ",\"note\":\"spinning now; saved in the camera row\"" : ""
    return "{\(Self.camera(camera, spin: turning).dropFirst().dropLast()),\"seconds\":\(JS.string(seconds))\(note)}"
  }

  /// A move a hand cut short by taking the graph, or one a new graph replaced.
  private static let stopped =
    #"{"stopped":"the view was taken over before the move finished; call get_graph for where it is"}"#

  /// animate_slider (the site's former voice mode's `animateSlider`): glide a slider's row to a
  /// value at a steady rate, by rewriting it. It answers as the glide
  /// starts, saying where it will stop.
  func animateSlider(_ name: String, to: Double, from: Double?, seconds: Double) async -> String {
    guard let model else { return Self.notReady }
    let lines = rows()
    let analysis = analyzeDeep(lines)
    let sliders = analysis.rows.indices.filter { analysis.rows[$0].slider != nil && analysis.rows[$0].error == nil }
    // (A redefined built-in, `e := 0.6`, by the name its row wrote.)
    let named = { (index: Int) in (analysis.rows[index].definition?.name).map(writtenName) }
    guard let index = sliders.first(where: { named($0) == name }),
      case .constant(_, let rhs, _)? = analysis.rows[index].definition,
      let form = sliderForm(rhs.trimmingCharacters(in: .whitespaces)), let slider = analysis.rows[index].slider
    else {
      let names = sliders.compactMap(named)
      let known = names.isEmpty ? "" : "; sliders: \(names.joined(separator: ", "))"
      return Self.object([("error", Self.quoted("no slider named \"\(name)\"\(known)"))])
    }
    // The slider's own value now; and where its range lets it stop.
    let start = from ?? slider.value
    let goal = form.whole ? to.rounded() : to
    let end = sliderValue(form, goal, sliderBounds(form, analysis.env, valueNames: analysis.valueNames))
    glides[name]?.cancel()
    glides[name] = Task { @MainActor [weak self] in
      let began = CACurrentMediaTime()
      var written: String?
      while !Task.isCancelled {
        guard let rows = self?.rows(), index < rows.count else { return }
        // The row was typed in, undone, or is another graph's: it is theirs now.
        if let written, rows[index] != written { return }
        let k = seconds > 0 ? min((CACurrentMediaTime() - began) / seconds, 1) : 1
        // Whole-number sliders glide in steps: a fraction would be an error for the whole glide.
        let value = start + (goal - start) * k
        model.setSlider(row: index, to: form.whole ? value.rounded() : value)
        written = self?.rows()[index]
        if k >= 1 {
          // The whole glide is one undo step.
          model.endGesture()
          return
        }
        try? await Task.sleep(for: .milliseconds(16))
      }
    }
    return Self.object([
      ("slider", Self.quoted(name)), ("from", JS.string(start)), ("to", JS.string(end)),
      ("seconds", JS.string(seconds)), ("note", end != to ? Self.quoted("held to the slider's range") : nil),
    ])
  }

  /// check (lib/assistant-tools.ts `checkRows`): what the rows would draw, without drawing them.
  func check(_ rows: [String]) async -> String {
    let texts = rows.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    let analysis = analyzeDeep(texts)
    let entries = texts.indices.map { k -> String in
      let report = analysis.describe(row: k, texts: texts, kindMeanings: Self.kindMeanings)
      return Self.object([
        ("row", Self.quoted(texts[k])), ("kind", report.kind.map(Self.quoted)),
        ("meaning", report.meaning.map(Self.quoted)), ("value", report.value.map(Self.quoted)),
        ("note", Self.fileNote(analysis.rows[k]).map(Self.quoted)),
        ("error", report.error.map(Self.quoted)), ("hint", report.hint.map(Self.quoted)),
        ("warning", report.warning.map(Self.quoted)),
      ])
    }
    return "[\(entries.joined(separator: ","))]"
  }

  func listKinds() async -> String { Self.lookups?.listKinds() ?? Self.noLookups }
  func kindExamples(_ kind: String) async -> String { Self.lookups?.kindExamples(kind) ?? Self.noLookups }
  func shape(_ name: String) async -> String { Self.lookups?.shape(name) ?? Self.noLookups }
  func searchFunctions(_ query: String) async -> String { Self.lookups?.searchFunctions(query) ?? Self.noLookups }
  func functionDoc(_ name: String) async -> String { Self.lookups?.functionDoc(name) ?? Self.noLookups }

  /// What a row that reads a data file says of it: the tools read the rows
  /// without their files, so the row is right and its data is not here
  /// (worker/mcp.ts, a row's `note: row.dataLocal`). Not an error to fix.
  private static func fileNote(_ row: RowAnalysis) -> String? {
    row.error == nil ? row.dataLocal : nil
  }

  /// `Math.round(v * 1e6) / 1e6`, as the site's reports round.
  private static func round6(_ v: Double) -> Double { (v * 1e6).rounded() / 1e6 }

  // The answers are written key by key, in the order the site's objects
  // have theirs: it is text a model reads.

  /// A JSON string.
  private static func quoted(_ text: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed, .withoutEscapingSlashes])
    return data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
  }

  /// A JSON object of the fields that have a value, in order.
  private static func object(_ fields: [(String, String?)]) -> String {
    "{" + fields.compactMap { key, value in value.map { "\(quoted(key)):\($0)" } }.joined(separator: ",") + "}"
  }

  private static func list(_ values: [Double]) -> String {
    "[" + values.map { JS.string(round6($0)) }.joined(separator: ",") + "]"
  }

  /// The live camera as get_graph reports it, spin included, so a move can
  /// be relative ("turn a bit left").
  private static func camera(_ camera: Camera3D, spin: Double) -> String {
    object([
      ("theta", JS.string(round6(camera.shownTheta))), ("phi", JS.string(round6(camera.phi))),
      ("radius", JS.string(round6(camera.radius))),
      ("target", list([camera.target.x, camera.target.y, camera.target.z])), ("spin", JS.string(spin)),
    ])
  }

  /// The graph as the tools report it (the `GraphState` of the site's former
  /// voice mode, its `panelGraph`): the mode, the first panel's window or camera, and every
  /// row as `rowStatus` describes it (EquationRender `describe`, the port
  /// of lib/assistant-tools.ts `describeRow`) with the color it draws in.
  /// Not reported: a curve's intercepts in view (`points`).
  private static func state(rows: [String], theme: GraphTheme, framing: MetalCanvas.Framing?) -> String {
    let read = GraphAnalysis(
      rows: rows.enumerated().map { GraphRow(id: -1 - $0.offset, text: $0.element) }, theme: theme)
    let analysis = read.content.analysis
    let entries = rows.indices.map { k -> String in
      let report = analysis.describe(row: k, texts: rows, kindMeanings: kindMeanings)
      let row = analysis.rows[k]
      // The color of a row that draws something, as hex.
      let draws =
        report.error == nil && row.classified != nil && row.definition == nil && !row.comment && row.view == nil
        && report.warning?.hasPrefix("not drawn") != true
      let color = draws ? read.status[k].color.flatMap { $0.count == 3 ? $0 : nil } : nil
      let hex = color.map { "#" + $0.map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined() }
      return object([
        ("index", "\(k)"), ("text", quoted(rows[k])), ("status", quoted(report.status)),
        ("error", report.error.map(quoted)), ("hint", report.hint.map(quoted)), ("kind", report.kind.map(quoted)),
        ("meaning", report.meaning.map(quoted)), ("value", report.value.map(quoted)),
        ("note", fileNote(row).map(quoted)), ("animated", report.animated ? "true" : nil),
        ("warning", report.warning.map(quoted)),
        ("color", hex.map(quoted)),
      ])
    }
    var fields: [(String, String?)] = []
    switch framing {
    case .window(let x, let y)?:
      fields = [("mode", quoted("2d")), ("window", object([("x", list(x)), ("y", list(y))]))]
    case .camera(let camera, let spin)?:
      fields = [("mode", quoted("3d")), ("camera", Self.camera(camera, spin: spin))]
    case nil:
      fields = [("mode", quoted(analysis.is3D ? "3d" : "2d"))]
    }
    return object(fields + [("rows", "[\(entries.joined(separator: ","))]")])
  }
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
        tools: ChatModel.tools(access),
        instructions: ChatModel.instructions)
    self.session = session
    let prompt = ChatModel.prompt(text, rows: before, status: access.model?.status ?? [])
    messages.append(Message(role: .assistant, text: ""))
    let reply = messages.count - 1
    do {
      for try await snapshot in session.streamResponse(to: prompt, options: ChatModel.options) {
        messages[reply].text = snapshot.content
        if !snapshot.content.isEmpty { activity = nil }
      }
      // A row with an error: ask once to fix it, and the fixed reply replaces the first.
      if let followUp = ChatModel.followUp(rows: access.rows(), status: await currentStatus()) {
        activity = "Fixing…"
        for try await snapshot in session.streamResponse(to: followUp, options: ChatModel.options) {
          if !snapshot.content.isEmpty {
            messages[reply].text = snapshot.content
            activity = nil
          }
        }
        if ChatModel.followUp(rows: access.rows(), status: await currentStatus()) != nil {
          messages.append(Message(role: .note, text: ChatModel.stillAnError))
        }
      }
    } catch LanguageModelError.contextSizeExceeded {
      self.session = nil
      messages[reply] = Message(role: .note, text: "That conversation got too long, so it starts afresh. Ask again.")
    } catch {
      if let quota = ChatModel.Quota(reached: error) {
        messages[reply] = Message(role: .note, text: quota.text())
      } else {
        messages[reply] = Message(role: .note, text: error.localizedDescription)
      }
    }
    if messages[reply].role == .assistant && messages[reply].text.isEmpty { messages.remove(at: reply) }
    if access.rows() != before { undoRows = before }
  }

  /// Every row's status once the renderer has drawn the rows as they are now.
  private func currentStatus() async -> [RowStatus] {
    await access.model?.status(after: access.rows()) ?? []
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
