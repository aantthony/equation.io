#if os(iOS)
  import SwiftUI
  import UniformTypeIdentifiers

  /// iPhone and iPad keep their graphs themselves rather than through the
  /// system's document browser, whose import step made every new graph wait
  /// (seconds on a device): the app opens straight into a new graph, which
  /// saves itself into the app's folder (Files ▸ On My iPhone ▸ Equation)
  /// once edited, and an Open list finds the rest.
  @MainActor @Observable
  final class GraphStore {
    var document: GraphDocument
    /// Where the graph saves: nil for a new graph not yet edited.
    private(set) var url: URL?
    /// The rows as last saved (or as opened), and the data files with them, so
    /// an unedited graph never writes.
    private var saved: [String]
    private var savedFiles: [String] = []
    /// A file outside the app's folder, held open for as long as it is shown.
    private var scoped: URL?
    private var pendingSave: Task<Void, Never>?
    /// Why the last open or save failed, for an alert.
    var problem: String?

    init() {
      let document = GraphDocument()
      self.document = document
      saved = document.rows.map(\.text)
    }

    /// The graph's name: its file's, or "New Graph" until it has one.
    var title: String { url?.deletingPathExtension().lastPathComponent ?? "New Graph" }

    /// The app's folder in Files.
    static var folder: URL { .documentsDirectory }

    /// Start a new graph: the default one, or an example's rows.
    func newGraph(rows: [String]? = nil) {
      flush()
      release()
      show(rows.map { GraphDocument(rows: $0) } ?? GraphDocument(), at: nil)
    }

    /// Open a saved graph. `external` files (from Files, Mail, another app)
    /// are outside the app's sandbox, and stay accessible while shown.
    func open(_ url: URL, external: Bool = false) {
      guard url != self.url else { return }
      flush()
      release()
      if external && url.startAccessingSecurityScopedResource() { scoped = url }
      do {
        show(try GraphDocument(data: Data(contentsOf: url)), at: url)
      } catch {
        problem = "Couldn't open \(url.lastPathComponent): \(error.localizedDescription)"
        release()
      }
    }

    private func show(_ next: GraphDocument, at url: URL?) {
      var next = next
      next.follow(document)
      document = next
      self.url = url
      saved = next.rows.map(\.text)
      savedFiles = next.savedFiles
    }

    /// The graph changed: save it once typing pauses.
    func changed() {
      guard document.rows.map(\.text) != saved || document.savedFiles != savedFiles else { return }
      pendingSave?.cancel()
      pendingSave = Task {
        try? await Task.sleep(for: .milliseconds(500))
        if !Task.isCancelled { save() }
      }
    }

    /// Save now if anything is waiting to (leaving a graph, going to the background).
    func flush() {
      guard pendingSave != nil else { return }
      pendingSave?.cancel()
      save()
    }

    private func save() {
      pendingSave = nil
      let texts = document.rows.map(\.text)
      guard texts != saved || document.savedFiles != savedFiles else { return }
      let target = url ?? Self.unusedURL()
      do {
        try document.encoded().write(to: target, options: .atomic)
        url = target
        saved = texts
        savedFiles = document.savedFiles
      } catch {
        problem = "Couldn't save \(target.lastPathComponent): \(error.localizedDescription)"
      }
    }

    /// "Graph", then "Graph 2", "Graph 3", … whichever is free.
    private static func unusedURL() -> URL {
      var n = 1
      while true {
        let url = folder.appending(path: n == 1 ? "Graph.equation" : "Graph \(n).equation")
        if !FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) { return url }
        n += 1
      }
    }

    private func release() {
      scoped?.stopAccessingSecurityScopedResource()
      scoped = nil
    }

    /// The graphs in the app's folder, most recently changed first.
    func files() -> [GraphFile] {
      let urls =
        (try? FileManager.default.contentsOfDirectory(
          at: Self.folder, includingPropertiesForKeys: [.contentModificationDateKey], options: .skipsHiddenFiles))
        ?? []
      return
        urls
        .filter { $0.pathExtension == "equation" }
        .map { url in
          GraphFile(
            url: url, name: url.deletingPathExtension().lastPathComponent,
            modified: (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
              ?? .distantPast)
        }
        .sorted { $0.modified > $1.modified }
    }

    func delete(_ file: GraphFile) {
      if file.url == url {
        pendingSave?.cancel()
        pendingSave = nil
        show(GraphDocument(), at: nil)
      }
      try? FileManager.default.removeItem(at: file.url)
    }
  }

  struct GraphFile: Identifiable, Hashable {
    var url: URL
    var name: String
    var modified: Date
    var id: URL { url }
  }

  /// The app on iPhone and iPad: one graph at a time, from the store.
  struct GraphLibraryRoot: View {
    @State private var store = GraphStore()
    @State private var showingFiles = false
    @Environment(\.scenePhase) private var phase

    var body: some View {
      DocumentView(
        document: $store.document,
        library: LibraryActions(
          title: store.title,
          open: { showingFiles = true },
          new: { store.newGraph() },
          example: { store.newGraph(rows: $0) })
      )
      .onChange(of: store.document.rows) { store.changed() }
      // (A missing file supplied changes no row, and is to be saved all the same.)
      .onChange(of: store.document.savedFiles) { store.changed() }
      .onChange(of: phase) { if phase != .active { store.flush() } }
      .onOpenURL { store.open($0, external: true) }
      .sheet(isPresented: $showingFiles) {
        GraphFilesView(store: store)
      }
      .alert(
        "Problem", isPresented: Binding(get: { store.problem != nil }, set: { if !$0 { store.problem = nil } })
      ) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(store.problem ?? "")
      }
    }
  }

  /// Open: the graphs in the app's folder, a new graph, and the rest of Files.
  private struct GraphFilesView: View {
    var store: GraphStore
    @State private var files: [GraphFile] = []
    @State private var browsing = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
      NavigationStack {
        List {
          Button("New Graph", systemImage: "plus") {
            store.newGraph()
            dismiss()
          }
          Section("On This \(UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")") {
            if files.isEmpty {
              Text("Graphs you edit are saved here.").foregroundStyle(.secondary)
            }
            ForEach(files) { file in
              Button {
                store.open(file.url)
                dismiss()
              } label: {
                HStack {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(file.name).foregroundStyle(.primary)
                    Text(file.modified, format: .relative(presentation: .named))
                      .font(.caption)
                      .foregroundStyle(.secondary)
                  }
                  Spacer()
                  if file.url == store.url {
                    Image(systemName: "checkmark").foregroundStyle(.tint)
                  }
                }
              }
            }
            .onDelete { offsets in
              for file in offsets.map({ files[$0] }) { store.delete(file) }
              files = store.files()
            }
          }
        }
        .navigationTitle("Open")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
          ToolbarItem(placement: .primaryAction) { Button("Browse…") { browsing = true } }
        }
        .fileImporter(isPresented: $browsing, allowedContentTypes: [.equationGraph]) { result in
          if case .success(let url) = result {
            store.open(url, external: true)
            dismiss()
          }
        }
      }
      .onAppear {
        store.flush()
        files = store.files()
      }
    }
  }
#endif

/// What the window offers when the app keeps its own graphs (iPhone and iPad).
struct LibraryActions {
  var title: String
  var open: () -> Void
  var new: () -> Void
  /// An example opens as a new graph, leaving the current one as it was.
  var example: ([String]) -> Void
}
