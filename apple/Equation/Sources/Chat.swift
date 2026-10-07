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
    case .unavailable(.deviceNotEligible): "This device can't run Apple Intelligence, which the chat needs."
    case .unavailable(.appleIntelligenceNotEnabled): "Turn on Apple Intelligence in Settings to use the chat."
    case .unavailable(.modelNotReady): "Apple Intelligence is still getting ready. Try again in a little while."
    case .unavailable: "The chat isn't available on this device."
    }
  }

  /// What the model is told before any conversation: the app, the tools and
  /// a primer of the language (the full reference is a tool call away).
  static let instructions = """
    You are the assistant inside Equation.io, a graphing calculator. The user's \
    graph is a list of rows; each row is one equation, inequality, definition, \
    point or comment, drawn in its own color. Each message tells you the graph's \
    rows as they are now.

    To change the graph, call set_rows with the complete new list of rows. \
    Change the row the request is about rather than adding a near copy of it, \
    and keep every other row as it is, in order. set_rows reports any row with \
    an error: fix those and call it again. Never just describe a change; make \
    it. Then reply in one short sentence, without listing the rows.

    Each row is its own string in the list. Examples of set_rows calls, when \
    the graph's only row is "y = sin(x)":
    - "add a slider for the amplitude": rows ["A = 1", "y = A sin(x)"]
    - "make it move": rows ["y = sin(x - t)"]
    - "draw the derivative too": rows ["y = sin(x)", "y = d/dx sin(x)"]
    - "shade the area under it from 0 to π": rows ["y = sin(x)", "int[0..pi] sin(x) dx"]
    - "add a tangent line at x = 1": rows ["f(x) = sin(x)", "g(x) = d/dx f(x)", \
    "a = 1", "y = f(x)", "y = f(a) + g(a)(x - a)"]

    Writing rows:
    - y = x^2 is a curve; x^2 + y^2 = 4 an implicit curve; y < sin(x) a shaded region.
    - a = 2 is a number the user can drag as a slider; then y = sin(a x).
    - f(x) = x^3 - 2x defines a function; d/dx f(x) is its derivative.
    - int[0..2] f(x) dx shades that area and shows its value.
    - t is time in seconds: y = sin(x - 2t) animates.
    - Parametric curves use u from 0 to 1: (2cos(2pi u), sin(2pi u)).
    - z makes it 3D: z = x^2 - y^2 is a surface.
    - (-y, x) is a vector field. A = (1, 2) is a draggable point.
    - sum[n=1..N] f(n) is a sum. # Title is a heading row; y = x # note adds a note.
    - Multiply by writing things side by side: 2x, a x, 2pi u.
    - Don't name things i, e, pi, tau or d; they are taken.
    Only for something these don't cover, call look_up_syntax first.
    """
}

// MARK: - The graph, as the chat sees it

/// The open graph, for the chat's tools.
@MainActor final class GraphAccess {
  var rows: () -> [String] = { [] }
  var apply: ([String]) -> Void = { _ in }
  weak var model: GraphModel?

  /// Change the graph and say how each row drew.
  func set(_ rows: [String]) async -> String {
    apply(rows)
    let status = await model?.status(after: rows) ?? []
    return Self.report(rows, status)
  }

  /// The rows, numbered, each with what the graph says about it.
  static func report(_ rows: [String], _ status: [RowStatus]) -> String {
    if rows.isEmpty { return "The graph is empty." }
    var errors = 0
    let lines = rows.enumerated().map { k, row in
      var line = "\(k + 1). \(row)"
      if k < status.count {
        if let error = status[k].error {
          errors += 1
          line += "   <- ERROR: \(error)"
        } else if let info = status[k].info {
          line += "   (= \(info))"
        }
      }
      return line
    }
    let verdict =
      errors == 0
      ? "Every row draws."
      : "\(errors) row\(errors == 1 ? " has an error" : "s have errors"): fix \(errors == 1 ? "it" : "them") with set_rows."
    return lines.joined(separator: "\n") + "\n" + verdict
  }
}

// MARK: - Tools

/// Replaces the graph's rows, and reports back how each one drew.
struct SetRows: Tool {
  let access: GraphAccess
  let name = "set_rows"
  let description = """
    Replace the graph with these rows, in order: one equation, inequality, \
    definition, point or comment per row. Returns each row with its error, if any.
    """

  @Generable
  struct Arguments {
    @Guide(description: "Every row of the new graph, in order. Keep the rows the user didn't ask to change.")
    var rows: [String]
  }

  func call(arguments: Arguments) async throws -> String {
    let rows = arguments.rows.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    return await access.set(rows)
  }
}

/// Searches the language reference (llms.txt, bundled by pnpm app:web).
struct LookUpSyntax: Tool {
  let name = "look_up_syntax"
  let description = """
    Look up how to write something in Equation.io: a function, a kind of plot, \
    or a feature. Returns the matching parts of the language reference.
    """

  @Generable
  struct Arguments {
    @Guide(description: "What to look up, in a few words, like \"parametric curve\" or \"slider range\".")
    var topic: String
  }

  func call(arguments: Arguments) async throws -> String {
    Reference.search(arguments.topic)
  }
}

/// The language reference, in passages: each bullet or paragraph, under its section.
enum Reference {
  struct Passage {
    var section: String
    var text: String
  }

  static let passages: [Passage] = {
    guard let url = Bundle.main.resourceURL?.appending(path: "Web/llms.txt"),
      let text = try? String(contentsOf: url, encoding: .utf8)
    else { return [] }
    var passages: [Passage] = []
    var section = ""
    var current = ""
    func close() {
      let body = current.trimmingCharacters(in: .whitespacesAndNewlines)
      if !body.isEmpty { passages.append(Passage(section: section, text: body)) }
      current = ""
    }
    for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
      if line.hasPrefix("## ") {
        close()
        section = String(line.dropFirst(3))
      } else if line.isEmpty || line.hasPrefix("- ") {
        close()
        current = String(line)
      } else {
        current += "\n" + line
      }
    }
    close()
    return passages
  }()

  /// The passages that best match the topic's words, up to about 2,500 characters.
  static func search(_ topic: String) -> String {
    let words = topic.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 1 }
    guard !words.isEmpty else { return "Say what to look up." }
    let scored = passages.compactMap { passage -> (Int, Passage)? in
      let haystack = (passage.section + " " + passage.text).lowercased()
      let score = words.reduce(0) { $0 + haystack.components(separatedBy: $1).count - 1 }
      return score > 0 ? (score, passage) : nil
    }
    .sorted { $0.0 > $1.0 }
    var out = ""
    for (_, passage) in scored.prefix(6) {
      let piece = "[\(passage.section)]\n\(passage.text)\n\n"
      if out.count + piece.count > 2500 { break }
      out += piece
    }
    return out.isEmpty ? "Nothing in the reference matches \"\(topic)\"." : out
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
  /// The graph as it was before the last reply changed it, for Undo.
  private(set) var undoRows: [String]?

  @ObservationIgnored let access = GraphAccess()
  @ObservationIgnored private var session: LanguageModelSession?

  func send(_ text: String) {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !isResponding else { return }
    Task { await respond(to: text) }
  }

  private func respond(to text: String) async {
    messages.append(Message(role: .user, text: text))
    isResponding = true
    defer { isResponding = false }
    let before = access.rows()
    let session =
      self.session
      ?? LanguageModelSession(
        model: ChatModel.make(), tools: [SetRows(access: access), LookUpSyntax()],
        instructions: ChatModel.instructions)
    self.session = session
    let prompt = "The graph's rows now:\n\(GraphAccess.report(before, access.model?.status ?? []))\n\n\(text)"
    messages.append(Message(role: .assistant, text: ""))
    let reply = messages.count - 1
    do {
      for try await snapshot in session.streamResponse(to: prompt) {
        messages[reply].text = snapshot.content
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

  /// Put the graph back as it was before the last reply changed it.
  func undo() {
    guard let rows = undoRows else { return }
    access.apply(rows)
    undoRows = nil
    messages.append(Message(role: .note, text: "Put the graph back as it was."))
  }

  /// Forget the conversation (the graph stays as it is).
  func reset() {
    session = nil
    messages = []
    undoRows = nil
  }
}

// MARK: - The view

/// Ask for a change to the graph in words.
struct ChatView: View {
  var chat: GraphChat
  @State private var draft = ""
  @FocusState private var focused: Bool
  @Environment(\.dismiss) private var dismiss

  private let suggestions = [
    "Add a slider for the amplitude",
    "Draw the derivative too",
    "Shade the area under the curve from 0 to π",
    "Animate it over time",
  ]

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        ScrollViewReader { scroll in
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
              if chat.messages.isEmpty { intro }
              ForEach(chat.messages) { message in
                bubble(message).id(message.id)
              }
              if chat.isResponding && chat.messages.last?.text.isEmpty != false {
                ProgressView().padding(.leading, 4)
              }
            }
            .padding()
          }
          .onChange(of: chat.messages.last?.text) {
            if let last = chat.messages.last { withAnimation { scroll.scrollTo(last.id, anchor: .bottom) } }
          }
        }
        composer
      }
      .navigationTitle("Ask")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
        ToolbarItemGroup(placement: .primaryAction) {
          if chat.undoRows != nil {
            Button("Undo Change", systemImage: "arrow.uturn.backward") { chat.undo() }
          }
          if !chat.messages.isEmpty {
            Button("New Conversation", systemImage: "square.and.pencil") { chat.reset() }
          }
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 420, minHeight: 480)
    #endif
  }

  @ViewBuilder private var intro: some View {
    if let reason = ChatModel.unavailableReason {
      Label(reason, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
    } else {
      Text("Ask for a change to the graph in your own words.")
        .foregroundStyle(.secondary)
      ForEach(suggestions, id: \.self) { suggestion in
        Button(suggestion) { chat.send(suggestion) }
          .buttonStyle(.bordered)
      }
    }
  }

  @ViewBuilder private func bubble(_ message: GraphChat.Message) -> some View {
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

  private var composer: some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField("Ask to change the graph…", text: $draft, axis: .vertical)
        .lineLimit(1...4)
        .focused($focused)
        .onSubmit(send)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.quaternary, in: .rect(cornerRadius: 18))
      Button("Send", systemImage: "arrow.up.circle.fill", action: send)
        .labelStyle(.iconOnly)
        .font(.title2)
        .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || chat.isResponding)
    }
    .padding()
  }

  private func send() {
    chat.send(draft)
    draft = ""
  }
}
