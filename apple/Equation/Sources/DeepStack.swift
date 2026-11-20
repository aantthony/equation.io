import EquationCore
import Foundation

/// A thread with a deep stack, for reading and drawing rows.
///
/// The language's port walks a row's expression by recursion, as the site's
/// does, and a row may be deep: a Σ of 500 terms (the most the language
/// expands) is a sum 500 levels down. In a debug build that takes between 4
/// and 6 MB of stack, and 150 nested calls more than 1 MB; an iPhone's main
/// thread has 1 MB and a background queue's 512 KB. So everything that
/// analyzes rows, or evaluates what they came to, runs here: the caller
/// waits for it, as if it had called it itself.
enum DeepStack {
  /// (The Mac's main thread has 8 MB, and shares it with the views above the call.)
  private static let size = 32 << 20

  private final class Worker: @unchecked Sendable {
    let lock = NSCondition()
    var job: (() -> Void)?
    var busy = false
    var thread: Thread?

    func run(_ job: @escaping () -> Void) {
      lock.lock()
      // One caller at a time has the thread; a second (there is none today) waits its turn.
      while busy { lock.wait() }
      busy = true
      self.job = job
      if thread == nil {
        let thread = Thread { [unowned self] in self.loop() }
        thread.stackSize = DeepStack.size
        thread.name = "io.equation.deep-stack"
        thread.qualityOfService = .userInteractive
        self.thread = thread
        thread.start()
      }
      lock.broadcast()
      while self.job != nil { lock.wait() }
      busy = false
      lock.broadcast()
      lock.unlock()
    }

    private func loop() {
      lock.lock()
      while true {
        while job == nil { lock.wait() }
        let job = job!
        lock.unlock()
        job()
        lock.lock()
        self.job = nil
        lock.broadcast()
      }
    }
  }

  private static let worker = Worker()

  /// Carries a value the caller alone touches until the work is done.
  private final class Box<T>: @unchecked Sendable {
    var value: T?
  }

  /// `body`'s result, found on the deep thread while the caller waits. Work
  /// already there runs where it is.
  static func run<T>(_ body: () -> T) -> T {
    if Thread.current === worker.thread { return body() }
    let out = Box<T>()
    withoutActuallyEscaping(body) { body in
      let work = Box<() -> T>()
      work.value = body
      worker.run { out.value = work.value!() }
      work.value = nil
    }
    return out.value!
  }
}

/// EquationCore's `analyze`, with the stack a deep row needs (`DeepStack`).
func analyzeDeep(_ sources: [String], files: DataFiles? = nil) -> DocumentAnalysis {
  DeepStack.run { analyze(sources, files: files) }
}
