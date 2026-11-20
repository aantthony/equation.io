import SwiftUI

#if os(macOS)
  import AppKit
  typealias PlatformColor = NSColor
  typealias PlatformFont = NSFont
  typealias PlatformView = NSView
  typealias PlatformTextView = NSTextView
  typealias PlatformHostingController = NSHostingController
#else
  import UIKit
  typealias PlatformColor = UIColor
  typealias PlatformFont = UIFont
  typealias PlatformView = UIView
  typealias PlatformTextView = UITextView
  typealias PlatformHostingController = UIHostingController
#endif

/// The equations panel: the whole document as one text, one row per line,
/// so select-all, paste, undo and find work as in a code editor. The
/// renderer's word on each row — its color, syntax, error, readout and
/// slider — is laid over the text, as the web panel does.
@MainActor
struct EquationEditor {
  @Binding var document: GraphDocument
  var status: [RowStatus]
  var slide: @MainActor (Int, Double) -> Void
  /// A slider was let go: its drag is one undo step.
  var slid: @MainActor () -> Void = {}
  /// Flip a row's display toggle (`RowStatus.Toggle.id`).
  var flip: @MainActor (Int, String) -> Void = { _, _ in }
  /// A row asks for its data file: bring up the importer.
  var supply: @MainActor () -> Void = {}
  /// Files dropped on the equations are the document's to open, not text
  /// for a row; false when it takes none of them.
  var drop: @MainActor ([NSItemProvider]) -> Bool = { _ in false }
  #if os(iOS)
    /// The card the equations sit in on iPhone, which a pull at their top moves.
    @Environment(\.panelDrag) private var panelDrag
    @Environment(\.editorBottomInset) private var bottomInset
  #endif

  func makeCoordinator() -> EditorController { EditorController() }

  @MainActor private func update(_ controller: EditorController) {
    let document = $document
    controller.onEdit = { lines in document.wrappedValue.setLines(lines) }
    controller.slide = slide
    controller.slid = slid
    controller.flip = flip
    controller.supply = supply
    controller.drop = drop
    #if os(macOS)
      controller.textView.onDropFiles = drop
    #endif
    #if os(iOS)
      controller.panelDrag = panelDrag
      controller.bottomInset = bottomInset
    #endif
    controller.show(text: document.wrappedValue.text, status: status)
  }
}

#if os(macOS)
  extension EquationEditor: NSViewRepresentable {
    func makeNSView(context: Context) -> NSScrollView {
      let scroll = NSScrollView()
      scroll.hasVerticalScroller = true
      scroll.drawsBackground = false
      scroll.documentView = context.coordinator.textView
      update(context.coordinator)
      return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) { update(context.coordinator) }
  }
#else
  extension EquationEditor: UIViewRepresentable {
    func makeUIView(context: Context) -> EquationTextView {
      update(context.coordinator)
      return context.coordinator.textView
    }

    func updateUIView(_ view: EquationTextView, context: Context) { update(context.coordinator) }
  }
#endif

extension EnvironmentValues {
  /// How far the equations run on below the screen (the iPhone card's
  /// overhang), which their scrolling keeps the last row above.
  @Entry var editorBottomInset: CGFloat = 0
}

/// The text view, telling its controller when its width changes (which
/// rewraps the rows and resizes what sits under them).
final class EquationTextView: PlatformTextView {
  var onResize: () -> Void = {}
  private var laidOutWidth: CGFloat = 0

  #if os(macOS)
    override func setFrameSize(_ newSize: NSSize) {
      super.setFrameSize(newSize)
      if newSize.width != laidOutWidth {
        laidOutWidth = newSize.width
        onResize()
      }
    }

    /// Files dragged onto the equations (a CSV from the Finder) are the
    /// document's to open: a text view of its own would type their paths in.
    var onDropFiles: ([NSItemProvider]) -> Bool = { _ in false }

    private func files(_ sender: any NSDraggingInfo) -> [URL] {
      let board = sender.draggingPasteboard
      return board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    }

    override var acceptableDragTypes: [NSPasteboard.PasteboardType] { super.acceptableDragTypes + [.fileURL] }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
      files(sender).isEmpty ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
      files(sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
      let urls = files(sender)
      if urls.isEmpty { return super.performDragOperation(sender) }
      return onDropFiles(urls.compactMap { NSItemProvider(contentsOf: $0) })
    }
  #else
    override func layoutSubviews() {
      super.layoutSubviews()
      if bounds.width != laidOutWidth {
        laidOutWidth = bounds.width
        onResize()
      }
    }
  #endif
}

// MARK: - Style

/// The web editor's look (web/style.css): quiet syntax color, since hue
/// already means "this row is that curve" in the color bars.
@MainActor
private enum Style {
  static let fontSize: CGFloat = 15
  static let font = PlatformFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
  static let headingFont = PlatformFont.monospacedSystemFont(ofSize: fontSize, weight: .semibold)
  static let noteFont = PlatformFont.systemFont(ofSize: 12.5)
  static let lineHeight: CGFloat = 22
  /// Room left of the text for the row's color bar.
  static let indent: CGFloat = 22
  static let rowGap: CGFloat = 4
  static let barWidth: CGFloat = 4

  static let text = PlatformColor.themed(0x111111, 0xE6E8EA)
  static let base = PlatformColor.themed(0x555555, 0xAEB4BE)
  static let num = PlatformColor.themed(0x8A5A2E, 0xCFAE88)
  static let str = PlatformColor.themed(0x6B6540, 0xBDB48C)
  static let fn = PlatformColor.themed(0x3D6390, 0x9DB6D8)
  static let name = PlatformColor.themed(0x111111, 0xF4F5F7)
  static let unbound = PlatformColor.themed(0x9A9A9A, 0x767C88)
  static let muted = PlatformColor.themed(0x888888, 0x868D99)

  static func color(_ cls: String) -> PlatformColor {
    switch cls {
    case "num", "const": num
    case "str": str
    case "fn": fn
    case "coord", "name": name
    case "unbound": unbound
    default: base
    }
  }

  static func paragraph(spaceAfter: CGFloat) -> NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.minimumLineHeight = lineHeight
    style.maximumLineHeight = lineHeight
    style.firstLineHeadIndent = indent
    style.headIndent = indent
    style.paragraphSpacingBefore = rowGap
    style.paragraphSpacing = rowGap + spaceAfter
    return style
  }

  static let typing: [NSAttributedString.Key: Any] = [
    .font: font, .foregroundColor: base, .paragraphStyle: paragraph(spaceAfter: 0),
  ]
}

extension PlatformColor {
  /// A color that follows light and dark appearance.
  static func themed(_ light: UInt32, _ dark: UInt32) -> PlatformColor {
    func rgb(_ hex: UInt32) -> PlatformColor {
      PlatformColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
    #if os(macOS)
      return NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(dark) : rgb(light) }
    #else
      return UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) }
    #endif
  }
}

// MARK: - Controller

@MainActor
final class EditorController: NSObject {
  let textView = EquationTextView(usingTextLayoutManager: true)
  var onEdit: ([String]) -> Void = { _ in }
  var slide: @MainActor (Int, Double) -> Void = { _, _ in }
  var slid: @MainActor () -> Void = {}
  var flip: @MainActor (Int, String) -> Void = { _, _ in }
  var supply: @MainActor () -> Void = {}
  var drop: @MainActor ([NSItemProvider]) -> Bool = { _ in false }
  #if os(iOS)
    /// The card the equations sit in, on iPhone; nil beside the graph.
    var panelDrag: PanelDrag?
    /// How far the view runs on below the screen, which its scrolling keeps
    /// the last row above (with the home indicator).
    var bottomInset: CGFloat = 0 {
      didSet { if bottomInset != oldValue { applyBottomInset() } }
    }

    fileprivate func applyBottomInset() {
      let room = bottomInset > 0 ? bottomInset + (textView.window?.safeAreaInsets.bottom ?? 0) : 0
      textView.contentInset.bottom = room
      textView.verticalScrollIndicatorInsets.bottom = room
    }
    /// Whether the current drag is moving the card rather than the text.
    fileprivate var cardHasPan = false
    fileprivate var cardPanStart: CGFloat = 0
    fileprivate var lastPanY: CGFloat = 0
  #endif

  private var status: [RowStatus] = []
  /// Each row's color bar, and what sits under it, by line.
  private var bars: [PlatformView] = []
  private var widgets: [Int: PlatformHostingController<RowWidget>] = [:]
  private var widgetHeights: [Int: CGFloat] = [:]

  override init() {
    super.init()
    timing.debug("editor: made")
    let view = textView
    view.typingAttributes = Style.typing
    view.backgroundColor = .clear
    #if os(macOS)
      view.delegate = self
      view.isRichText = false
      view.allowsUndo = true
      view.drawsBackground = false
      view.isAutomaticQuoteSubstitutionEnabled = false
      view.isAutomaticDashSubstitutionEnabled = false
      view.isAutomaticTextReplacementEnabled = false
      view.isAutomaticSpellingCorrectionEnabled = false
      view.isContinuousSpellCheckingEnabled = false
      view.isGrammarCheckingEnabled = false
      view.isAutomaticTextCompletionEnabled = false
      view.textContainerInset = NSSize(width: 0, height: 8)
      view.isVerticallyResizable = true
      view.isHorizontallyResizable = false
      view.autoresizingMask = [.width]
      view.textContainer?.widthTracksTextView = true
      view.minSize = .zero
      view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
    #else
      view.delegate = self
      view.textDropDelegate = self
      view.autocorrectionType = .no
      view.autocapitalizationType = .none
      view.spellCheckingType = .no
      view.smartQuotesType = .no
      view.smartDashesType = .no
      view.smartInsertDeleteType = .no
      view.inlinePredictionType = .no
      view.alwaysBounceVertical = true
      view.keyboardDismissMode = .interactive
      view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 12)
    #endif
    view.onResize = { [weak self] in
      #if os(iOS)
        self?.applyBottomInset()  // the window, and its home indicator, are known by now
      #endif
      self?.restyle()
    }
    #if os(iOS)
      view.panGestureRecognizer.addTarget(self, action: #selector(followPan(_:)))
    #endif
  }

  private var storage: NSTextStorage {
    #if os(macOS)
      textView.textStorage!
    #else
      textView.textStorage
    #endif
  }

  private var isComposing: Bool {
    #if os(macOS)
      textView.hasMarkedText()
    #else
      textView.markedTextRange != nil
    #endif
  }

  /// Show the document's text and the renderer's status for it.
  func show(text: String, status: [RowStatus]) {
    var changed = false
    if storage.string != text, !isComposing {
      replaceChanged(with: text)
      changed = true
    }
    if changed || status != self.status {
      self.status = status
      restyle()
    }
  }

  /// Replace only what differs, so the caret and selection stay put when
  /// the renderer rewrites a row (a slider, a dragged point).
  private func replaceChanged(with text: String) {
    let old = storage.string as NSString
    let new = text as NSString
    let shared = min(old.length, new.length)
    var head = 0
    while head < shared && old.character(at: head) == new.character(at: head) { head += 1 }
    var tail = 0
    while tail < shared - head && old.character(at: old.length - 1 - tail) == new.character(at: new.length - 1 - tail) {
      tail += 1
    }
    let replacement = new.substring(with: NSRange(location: head, length: new.length - head - tail))
    storage.replaceCharacters(
      in: NSRange(location: head, length: old.length - head - tail),
      with: NSAttributedString(string: replacement, attributes: Style.typing))
  }

  private func edited() {
    onEdit(storage.string.split(separator: "\n", omittingEmptySubsequences: false).map(String.init))
    restyle()
  }

  // MARK: Styling

  private var lines: [NSRange] {
    let text = storage.string as NSString
    var ranges: [NSRange] = []
    var start = 0
    while true {
      let newline = text.range(of: "\n", range: NSRange(location: start, length: text.length - start))
      if newline.location == NSNotFound {
        ranges.append(NSRange(location: start, length: text.length - start))
        return ranges
      }
      ranges.append(NSRange(location: start, length: newline.location - start))
      start = newline.location + 1
    }
  }

  /// Color the rows and make room under each for what it shows.
  private func restyle() {
    guard !isComposing else { return }
    measureWidgets()
    let lines = lines
    let length = storage.length
    storage.beginEditing()
    for (i, line) in lines.enumerated() {
      let paragraph = NSRange(location: line.location, length: min(line.length + 1, length - line.location))
      let row = i < status.count ? status[i] : nil
      var attributes = Style.typing
      attributes[.paragraphStyle] = Style.paragraph(spaceAfter: widgetHeights[i].map { $0 + 2 } ?? 0)
      storage.setAttributes(attributes, range: paragraph)
      guard let row, line.length > 0 else { continue }
      if row.comment {
        storage.addAttributes([.font: Style.headingFont, .foregroundColor: Style.muted], range: line)
        continue
      }
      if row.view || row.divider {
        storage.addAttribute(.foregroundColor, value: Style.muted, range: line)
        continue
      }
      for span in row.spans where span.start < line.length {
        let range = NSRange(location: line.location + span.start, length: min(span.end, line.length) - span.start)
        storage.addAttribute(.foregroundColor, value: Style.color(span.cls), range: range)
      }
      if let note = row.note, note < line.length {
        storage.addAttributes(
          [.font: Style.noteFont, .foregroundColor: Style.muted],
          range: NSRange(location: line.location + note, length: line.length - note))
      }
    }
    storage.endEditing()
    layoutDecorations()
  }

  // MARK: Widgets

  private var widgetWidth: CGFloat {
    #if os(macOS)
      let inset: CGFloat = 0
    #else
      let inset = textView.textContainerInset.left + textView.textContainerInset.right
    #endif
    // (Less the text's own padding: the width a widget is laid out at is the one it is measured at.)
    return max(120, textView.bounds.width - inset - Style.indent - 12 - linePadding)
  }

  private var linePadding: CGFloat {
    #if os(macOS)
      textView.textContainer?.lineFragmentPadding ?? 0
    #else
      textView.textContainer.lineFragmentPadding
    #endif
  }

  /// Make, update or drop the view under each row that has something to show.
  private func measureWidgets() {
    let width = widgetWidth
    var heights: [Int: CGFloat] = [:]
    for (i, row) in status.enumerated() {
      guard
        row.slider != nil || row.error != nil || row.info != nil || row.unsupported != nil || row.toggles != nil
          || row.needsFile != nil
      else { continue }
      let widget = RowWidget(
        status: row, slide: { [weak self] value in self?.slide(i, value) }, slid: { [weak self] in self?.slid() },
        flip: { [weak self] toggle in self?.flip(i, toggle) }, supply: { [weak self] in self?.supply() })
      let host: PlatformHostingController<RowWidget>
      if let existing = widgets[i] {
        host = existing
        host.rootView = widget
      } else {
        host = PlatformHostingController(rootView: widget)
        #if os(iOS)
          host.view.backgroundColor = .clear
        #endif
        textView.addSubview(host.view)
        widgets[i] = host
      }
      heights[i] = ceil(host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    }
    for (i, host) in widgets where heights[i] == nil {
      host.view.removeFromSuperview()
      widgets[i] = nil
    }
    widgetHeights = heights
  }

  /// Place each row's color bar beside its text and its widget under it.
  private func layoutDecorations() {
    guard let layout = textView.textLayoutManager,
      let content = layout.textContentManager as? NSTextContentStorage
    else { return }
    layout.ensureLayout(for: layout.documentRange)
    #if os(macOS)
      let origin = textView.textContainerOrigin
    #else
      let origin = CGPoint(x: textView.textContainerInset.left, y: textView.textContainerInset.top)
    #endif
    let lines = lines
    while bars.count < lines.count {
      let bar = PlatformView()
      #if os(macOS)
        bar.wantsLayer = true
        bar.layer?.cornerRadius = Style.barWidth / 2
      #else
        bar.layer.cornerRadius = Style.barWidth / 2
        bar.isUserInteractionEnabled = false
      #endif
      textView.addSubview(bar)
      bars.append(bar)
    }
    for (i, bar) in bars.enumerated() {
      guard i < lines.count,
        !(lines[i].length == 0 && lines[i].location == storage.length && i > 0),
        let location = content.location(content.documentRange.location, offsetBy: lines[i].location),
        let fragment = layout.textLayoutFragment(for: location),
        let first = fragment.textLineFragments.first, let last = fragment.textLineFragments.last
      else {
        bar.isHidden = true
        widgets[i]?.view.isHidden = true
        continue
      }
      let frame = fragment.layoutFragmentFrame
      let top = origin.y + frame.minY + first.typographicBounds.minY
      let bottom = origin.y + frame.minY + last.typographicBounds.maxY
      let row = i < status.count ? status[i] : nil
      if let rgb = row?.color, rgb.count == 3, row?.comment == false {
        bar.isHidden = false
        bar.frame = CGRect(x: origin.x + 6, y: top + 1, width: Style.barWidth, height: bottom - top - 2)
        let color = PlatformColor(red: rgb[0], green: rgb[1], blue: rgb[2], alpha: 1)
        #if os(macOS)
          bar.layer?.backgroundColor = color.cgColor
        #else
          bar.backgroundColor = color
        #endif
      } else {
        bar.isHidden = true
      }
      if let host = widgets[i], let height = widgetHeights[i] {
        host.view.isHidden = false
        host.view.frame = CGRect(
          x: origin.x + Style.indent + linePadding, y: bottom + 2, width: widgetWidth, height: height)
      }
    }
  }
}

#if os(macOS)
  extension EditorController: NSTextViewDelegate {
    func textDidChange(_ notification: Notification) { edited() }
  }
#else
  extension EditorController: UITextViewDelegate {
    func textViewDidChange(_ textView: UITextView) { edited() }

    /// A drag the card took ends with the equations still at their top, not
    /// coasting on the drag's speed.
    func scrollViewWillEndDragging(
      _ scrollView: UIScrollView, withVelocity velocity: CGPoint,
      targetContentOffset: UnsafeMutablePointer<CGPoint>
    ) {
      if cardHasPan { targetContentOffset.pointee.y = -scrollView.adjustedContentInset.top }
    }

    /// Share one drag between the equations and their card, as a sheet does
    /// with its scroll view: a pull down at the top of the equations, or a
    /// push up while the card can still grow, moves the card (the equations
    /// held at their top); anything else scrolls them. Ownership is decided
    /// afresh as the drag goes, so scrolling up to the top and pulling on
    /// carries straight into moving the card.
    @objc func followPan(_ pan: UIPanGestureRecognizer) {
      guard let card = panelDrag else { return }
      // In the window's space: the text view moves with the card.
      let y = pan.translation(in: nil).y
      let top = -textView.adjustedContentInset.top
      switch pan.state {
      case .began:
        cardHasPan = false
        lastPanY = y
      case .changed:
        let down = y > lastPanY
        let up = y < lastPanY
        lastPanY = y
        if !cardHasPan {
          let atTop = textView.contentOffset.y <= top + 0.5
          if (down && atTop) || (up && card.canGrow()) {
            cardHasPan = true
            cardPanStart = y
          }
        } else if up && !card.canGrow() && cardPanStart - y > 0 {
          // Grown all the way: the rest of the push scrolls the equations.
          card.ended(0)
          cardHasPan = false
        }
        if cardHasPan {
          textView.contentOffset.y = top
          card.moved(y - cardPanStart)
        }
      case .ended, .cancelled, .failed:
        if cardHasPan {
          // How much further a flick would carry the card.
          card.ended(pan.velocity(in: nil).y * 0.18)
          textView.contentOffset.y = top
        }
      default:
        break
      }
    }
  }
#endif

#if os(iOS)
  extension EditorController: UITextDropDelegate {
    /// A file dragged onto the equations (a CSV from Files) is the
    /// document's to open; left to the text view, its text would be typed
    /// into a row. Text dragged in is still text.
    func textDroppableView(
      _ textDroppableView: any UIView & UITextDroppable, proposalForDrop drop: any UITextDropRequest
    ) -> UITextDropProposal {
      guard drop.dropSession.items.contains(where: { DataImport.isFile($0.itemProvider) }) else {
        return drop.suggestedProposal
      }
      let proposal = UITextDropProposal(operation: .copy)
      proposal.dropPerformer = .delegate
      return proposal
    }

    func textDroppableView(
      _ textDroppableView: any UIView & UITextDroppable, willPerformDrop drop: any UITextDropRequest
    ) {
      let files = drop.dropSession.items.map(\.itemProvider).filter(DataImport.isFile)
      if !files.isEmpty { _ = self.drop(files) }
    }
  }
#endif

/// What sits under a row: its slider, its display toggles, then its error
/// or readout (the order of web/main.ts `reconcile`).
struct RowWidget: View {
  var status: RowStatus
  var slide: @MainActor (Double) -> Void
  var slid: @MainActor () -> Void = {}
  var flip: @MainActor (String) -> Void = { _ in }
  /// Ask for the row's data file.
  var supply: @MainActor () -> Void = {}

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let slider = status.slider, slider.max > slider.min {
        HStack(spacing: 8) {
          Text(slider.min.formatted()).monospacedDigit()
          Slider(
            value: Binding(get: { slider.value }, set: { slide($0) }),
            in: slider.min...slider.max,
            step: slider.step > 0 ? slider.step : (slider.max - slider.min) / 400,
            onEditingChanged: { editing in if !editing { slid() } }
          )
          .controlSize(.small)
          Text(slider.max.formatted()).monospacedDigit()
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      if let toggles = status.toggles {
        HStack(spacing: 6) {
          ForEach(toggles, id: \.id) { toggle in
            Toggle(toggle.label, isOn: Binding(get: { toggle.on }, set: { _ in flip(toggle.id) }))
              .toggleStyle(.button)
              .controlSize(.small)
              .help(toggle.help)
          }
        }
        .font(.caption)
      }
      if let error = status.error {
        Text(error)
          .font(.caption)
          .foregroundStyle(Color(Style.errorColor))
          .fixedSize(horizontal: false, vertical: true)
      } else if let needsFile = status.needsFile {
        // Not an error: the row is right, and its file is elsewhere. The row
        // that names the file is where it is asked for (on the site the
        // message is itself the button); a drop anywhere supplies it too.
        Text(needsFile)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if status.opensFile == true {
          Button("Choose File…", systemImage: "tray.and.arrow.down", action: supply)
            .controlSize(.small)
            .font(.caption)
        }
      } else if let unsupported = status.unsupported {
        // Not an error: the site draws the row, and the app will.
        Text(unsupported)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      } else if let info = status.info {
        Text(info)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

extension Style {
  static let errorColor = PlatformColor.themed(0xC0392B, 0xF0797D)
}
