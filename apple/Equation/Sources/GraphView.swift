import SwiftUI
import WebKit

/// The renderer's side of one open document: what it says about the rows,
/// and the way to move a slider it owns.
@MainActor @Observable
final class GraphModel {
  /// Index-aligned with the rows the renderer last drew.
  var status: [RowStatus] = []
  /// Counts the renderer's reports, so a change can wait for its verdict.
  @ObservationIgnored private(set) var statusReports = 0
  fileprivate weak var bridge: GraphBridge?
  /// The Metal view, while it is the one drawing the graph (MetalGraphView.swift).
  @ObservationIgnored weak var metal: MetalCanvas?

  func setSlider(row index: Int, to value: Double) {
    bridge?.call("window.equationApp.setSlider(index, value)", ["index": index, "value": value])
  }

  /// Glide the zoom about the graph's center: below 1 zooms in, above 1 out.
  func zoom(by factor: Double) {
    if let metal {
      metal.glideZoom(by: factor)
      return
    }
    bridge?.call("window.equationApp.zoom(factor)", ["factor": factor])
  }

  func reported() { statusReports += 1 }

  /// Ask the renderer something (`body` returns the answer) and wait for
  /// it, as JSON text.
  func ask(_ body: String, _ arguments: [String: Any] = [:]) async -> String? {
    await bridge?.ask(body, arguments)
  }

  /// The renderer's status for `rows`, once it has drawn them: waits for a
  /// report after this call that covers that many rows (or gives up after a
  /// couple of seconds and returns what it has).
  func status(after rows: [String]) async -> [RowStatus] {
    let start = statusReports
    for _ in 0..<40 {
      if statusReports > start && status.count == rows.count { break }
      try? await Task.sleep(for: .milliseconds(50))
    }
    return status
  }
}

/// The graph itself: the web renderer (web/native-app) in a WKWebView,
/// served from the app bundle under the `equation:` scheme.
@MainActor
struct GraphView {
  @Binding var document: GraphDocument
  var model: GraphModel
  @Environment(\.colorScheme) private var colorScheme

  func makeCoordinator() -> GraphBridge { GraphBridge() }

  @MainActor private func makeWebView(_ bridge: GraphBridge) -> WKWebView {
    timing.debug("graph: making web view")
    defer { timing.debug("graph: web view made") }
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)
    config.userContentController.add(WeakMessageHandler(bridge), name: "equation")
    #if DEBUG
      // The page's errors and warnings, in the app's own log.
      config.userContentController.add(WeakMessageHandler(bridge), name: "console")
      config.userContentController.addUserScript(
        WKUserScript(source: Self.consoleScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    #endif
    let web = WKWebView(frame: .zero, configuration: config)
    #if DEBUG
      web.isInspectable = true
    #endif
    #if os(iOS)
      web.isOpaque = false
      web.scrollView.isScrollEnabled = false
      web.scrollView.contentInsetAdjustmentBehavior = .never
    #endif
    bridge.web = web
    model.bridge = bridge
    update(bridge)
    web.load(URLRequest(url: BundleSchemeHandler.root.appending(path: "native-app/index.html")))
    return web
  }

  #if DEBUG
    private static let consoleScript = """
      (() => {
        const post = (level, args) => window.webkit.messageHandlers.console.postMessage(
          level + ': ' + args.map(a => a instanceof Error ? a.stack || String(a) : String(a)).join(' '));
        for (const level of ['error', 'warn']) {
          const original = console[level];
          console[level] = (...args) => { post(level, args); original.apply(console, args); };
        }
        addEventListener('error', e => post('uncaught', [e.error ?? e.message]));
        addEventListener('unhandledrejection', e => post('unhandled rejection', [e.reason]));
      })();
      """
  #endif

  @MainActor private func update(_ bridge: GraphBridge) {
    let document = $document
    let model = model
    bridge.onRows = { texts in document.wrappedValue.setLines(texts) }
    bridge.onStatus = { status in
      if model.status != status { model.status = status }
      model.reported()
    }
    bridge.sync(
      rows: document.wrappedValue.rows, generation: document.wrappedValue.generation, dark: colorScheme == .dark)
  }
}

#if os(iOS)
  extension GraphView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateUIView(_ web: WKWebView, context: Context) { update(context.coordinator) }
  }
#else
  extension GraphView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateNSView(_ web: WKWebView, context: Context) { update(context.coordinator) }
  }
#endif

/// Keeps the renderer showing the document's rows, and hands back what the
/// renderer changes itself.
@MainActor
final class GraphBridge: NSObject, WKScriptMessageHandler {
  weak var web: WKWebView?
  var onRows: ([String]) -> Void = { _ in }
  var onStatus: ([RowStatus]) -> Void = { _ in }

  /// What the renderer should show: the document's rows and the theme.
  private var rows: [GraphRow] = []
  private var generation = 0
  private var dark = false

  private var ready = false
  /// The rows and theme the renderer has.
  private var shownRows: [GraphRow]?
  private var shownGeneration = 0
  private var shownDark: Bool?
  /// Texts the renderer just wrote itself, which must not be sent back to it.
  private var echo: [String]?

  func sync(rows: [GraphRow], generation: Int, dark: Bool) {
    self.rows = rows
    self.generation = generation
    self.dark = dark
    flush()
  }

  private func flush() {
    guard ready else { return }
    if shownDark != dark {
      shownDark = dark
      call("window.equationApp.setTheme(mode)", ["mode": dark ? "dark" : "light"])
    }
    guard rows != shownRows || generation != shownGeneration else { return }
    if let echo, echo == rows.map(\.text) {
      self.echo = nil
      shownRows = rows
      return
    }
    let payload = rows.map { ["id": $0.id, "text": $0.text] as [String: Any] }
    // The first rows, or a replaced document, open a graph; edits keep the view.
    let method = shownRows == nil || generation != shownGeneration ? "loadRows" : "editRows"
    call("window.equationApp.\(method)(rows)", ["rows": payload])
    shownRows = rows
    shownGeneration = generation
  }

  func call(_ body: String, _ arguments: [String: Any]) {
    Task { _ = await ask(body, arguments) }
  }

  /// Run `body` in the page and wait for its result (a promise's, once it
  /// settles), as JSON text; nil if the page isn't there or the call threw.
  func ask(_ body: String, _ arguments: [String: Any]) async -> String? {
    guard let web, ready else { return nil }
    do {
      let wrapped = "return JSON.stringify(await (async () => { \(body) })())"
      return try await web.callAsyncJavaScript(wrapped, arguments: arguments, contentWorld: .page) as? String
    } catch {
      print("Renderer call failed: \(body): \(error)")
      return nil
    }
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    if message.name == "console" {
      print("Renderer \(message.body)")
      return
    }
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "ready":
      timing.debug("graph: renderer ready")
      // A (re)loaded page has nothing: send everything.
      ready = true
      shownRows = nil
      shownDark = nil
      echo = nil
      flush()
    case "rows":
      guard let texts = body["rows"] as? [String] else { return }
      echo = texts
      onRows(texts)
    case "status":
      guard let rows = body["rows"],
        let data = try? JSONSerialization.data(withJSONObject: rows),
        let status = try? JSONDecoder().decode([RowStatus].self, from: data)
      else { return }
      onStatus(status)
    default:
      break
    }
  }
}

/// WKUserContentController holds its handlers strongly.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: (any WKScriptMessageHandler)?
  init(_ target: any WKScriptMessageHandler) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

/// Serves the bundled renderer (Resources/Web) as equation://app/…, a real
/// origin for its module scripts, workers and storage.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "equation"
  static let root = URL(string: "\(scheme)://app/")!
  private let base = Bundle.main.resourceURL!.appending(path: "Web")

  func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    var path = url.path(percentEncoded: false)
    if path.hasSuffix("/") { path += "index.html" }
    let file = base.appending(path: String(path.drop { $0 == "/" })).standardizedFileURL
    // Nothing outside the bundled renderer.
    guard file.path.hasPrefix(base.standardizedFileURL.path + "/"), let data = try? Data(contentsOf: file) else {
      task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
      task.didFinish()
      return
    }
    let headers = ["Content-Type": Self.mimeType(file.pathExtension), "Content-Length": String(data.count)]
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}

  private static func mimeType(_ ext: String) -> String {
    switch ext.lowercased() {
    case "html": "text/html; charset=utf-8"
    case "js", "mjs": "text/javascript; charset=utf-8"
    case "css": "text/css; charset=utf-8"
    case "json": "application/json"
    case "svg": "image/svg+xml"
    case "png": "image/png"
    case "webp": "image/webp"
    case "woff2": "font/woff2"
    case "woff": "font/woff"
    case "wasm": "application/wasm"
    case "txt": "text/plain; charset=utf-8"
    default: "application/octet-stream"
    }
  }
}
