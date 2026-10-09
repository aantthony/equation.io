import FoundationModels
import SwiftUI

// MARK: - The graph, as the chat sees it

/// The open graph, for the chat's tools: the renderer, through its bridge.
@MainActor final class GraphAccess: GraphTools {
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

  func check(_ rows: [String]) async -> String {
    return await model?.ask("return window.equationApp.check(rows)", ["rows": rows])
      ?? #"{"error":"the graph isn't ready"}"#
  }

  func listKinds() async -> String { await text("return window.equationApp.listKinds()") }
  func kindExamples(_ kind: String) async -> String {
    await text("return window.equationApp.kindExamples(kind)", ["kind": kind])
  }
  func shape(_ name: String, values: [[String: Any]]) async -> String {
    await text("return window.equationApp.shape(name, values)", ["name": name, "values": values])
  }
  func searchFunctions(_ query: String) async -> String {
    await text("return window.equationApp.searchFunctions(query)", ["query": query])
  }
  func functionDoc(_ name: String) async -> String {
    await text("return window.equationApp.functionDoc(name)", ["name": name])
  }

  /// A tool whose answer is text: the page's string, which ask() hands back as JSON.
  private func text(_ body: String, _ arguments: [String: Any] = [:]) async -> String {
    guard let json = await model?.ask(body, arguments) else { return #"{"error":"the graph isn't ready"}"# }
    return (try? JSONDecoder().decode(String.self, from: Data(json.utf8))) ?? json
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
