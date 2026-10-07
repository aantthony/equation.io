import Foundation
import FoundationModels

// The Ask evals' runner: every task (apple/evals/tasks.ts), several times,
// through the app's own instructions and tools (apple/Equation/Sources/
// Assistant.swift, compiled in alongside this file). The tools act on the
// eval service (service.ts), which runs the real analyzer and grades the
// result.
//
//   pnpm app:eval                          # every task, 5 runs each
//   pnpm app:eval --runs 1 --task unit-cube --task slider-amplitude
//
// Results land in apple/evals/results/, one JSON file per invocation.

// MARK: - The service

/// service.ts, one JSON line in and one out.
@MainActor final class Service {
  private let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private var buffer = Data()

  init() throws {
    process.executableURL = URL(filePath: "/usr/bin/env")
    process.arguments = ["node", "--experimental-transform-types", "--no-warnings", "apple/evals/service.ts"]
    process.standardInput = input
    process.standardOutput = output
    try process.run()
  }

  func request(_ body: [String: Any]) throws -> [String: Any] {
    var line = try JSONSerialization.data(withJSONObject: body)
    line.append(0x0A)
    input.fileHandleForWriting.write(line)
    while true {
      if let end = buffer.firstIndex(of: 0x0A) {
        let answer = buffer[..<end]
        buffer.removeSubrange(...end)
        guard let object = try JSONSerialization.jsonObject(with: answer) as? [String: Any] else {
          throw RunnerError("the service answered \(String(decoding: answer, as: UTF8.self))")
        }
        if let error = object["error"] as? String { throw RunnerError("service: \(error)") }
        return object
      }
      let more = output.fileHandleForReading.availableData
      if more.isEmpty { throw RunnerError("the service exited") }
      buffer.append(more)
    }
  }

  deinit { process.terminate() }
}

struct RunnerError: Error, CustomStringConvertible {
  var description: String
  init(_ description: String) { self.description = description }
}

/// The chat's tools, acting on the service's graph.
@MainActor final class ServiceGraph: GraphTools {
  let service: Service
  init(_ service: Service) { self.service = service }

  private func tool(_ name: String, _ args: [String: Any]) -> String {
    do {
      return try service.request(["cmd": "tool", "name": name, "args": args])["output"] as? String ?? "null"
    } catch {
      return #"{"error":"the graph isn't ready"}"#
    }
  }

  func graph() async -> String { tool("get_graph", [:]) }
  func set(_ rows: [String]) async -> String { tool("set_graph", ["equations": rows]) }
  func moveView(_ target: [String: Any], seconds: Double) async -> String {
    tool("move_view", target.merging(["seconds": seconds]) { a, _ in a })
  }
  func animateSlider(_ name: String, to: Double, from: Double?, seconds: Double) async -> String {
    var args: [String: Any] = ["name": name, "to": to, "seconds": seconds]
    if let from { args["from"] = from }
    return tool("animate_slider", args)
  }
  func check(_ rows: [String]) async -> String { tool("check", ["equations": rows]) }
  func readSyntax(_ query: String) async -> String { tool("read_syntax", ["query": query]) }
}

// MARK: - Models

/// One request's answer: the reply, and the tokens it took where the model says.
struct Turn {
  var reply: String
  var inputTokens: Int?
  var outputTokens: Int?
}

/// A model the evals can run: the app's (on-device) today; a Claude baseline can join it.
protocol EvalModel: Sendable {
  var name: String { get }
  /// A fresh conversation's answer to one request, using the app's tools on `graph`.
  func respond(to prompt: String, graph: any GraphTools) async throws -> Turn
}

/// Apple's on-device model, as the app's Ask uses it (never Private Cloud Compute here).
struct OnDeviceModel: EvalModel {
  let name = "on-device"

  func respond(to prompt: String, graph: any GraphTools) async throws -> Turn {
    let session = LanguageModelSession(
      model: SystemLanguageModel.default, tools: ChatModel.tools(graph), instructions: ChatModel.instructions)
    let response = try await session.respond(to: prompt)
    return Turn(
      reply: response.content, inputTokens: session.usage.input.totalTokenCount,
      outputTokens: session.usage.output.totalTokenCount)
  }
}

enum ModelChoice: String {
  case onDevice = "on-device"
  case claude

  func make() throws -> any EvalModel {
    switch self {
    case .onDevice: OnDeviceModel()
    case .claude: throw RunnerError("the Claude baseline isn't written yet")
    }
  }
}

// MARK: - Running

/// Gives up on a run that takes longer than this (a model stuck calling tools).
let timeout: Duration = .seconds(180)

@main @MainActor
struct Runner {
  static func main() async {
    // A line per run as it finishes, even into a pipe or a log file.
    setvbuf(stdout, nil, _IOLBF, 0)
    do {
      try await run()
    } catch {
      FileHandle.standardError.write(Data("error: \(error)\n".utf8))
      exit(1)
    }
  }

  static func run() async throws {
    var runs = 5
    var only: [String] = []
    var choice = ModelChoice.onDevice
    var arguments = CommandLine.arguments.dropFirst()
    while let flag = arguments.popFirst() {
      switch flag {
      case "--runs": runs = Int(arguments.popFirst() ?? "") ?? runs
      case "--task": only.append(arguments.popFirst() ?? "")
      case "--model":
        guard let model = ModelChoice(rawValue: arguments.popFirst() ?? "") else { throw RunnerError("unknown model") }
        choice = model
      default: throw RunnerError("usage: runner [--runs N] [--task id]… [--model on-device|claude]")
      }
    }
    let model = try choice.make()
    let service = try Service()
    let graph = ServiceGraph(service)
    let all = try service.request(["cmd": "tasks"])["tasks"] as? [[String: Any]] ?? []
    let tasks = only.isEmpty ? all : all.filter { only.contains($0["id"] as? String ?? "") }

    var results: [String: Any] = [
      "model": model.name, "date": ISO8601DateFormatter().string(from: .now), "runs": runs,
    ]
    if choice == .onDevice {
      let system = SystemLanguageModel.default
      results["contextSize"] = system.contextSize
      results["instructionsTokens"] = try? await system.tokenCount(for: Instructions(ChatModel.instructions))
      results["toolsTokens"] = try? await system.tokenCount(for: ChatModel.tools(graph))
    }

    var taskResults: [[String: Any]] = []
    for task in tasks {
      let id = task["id"] as? String ?? "?"
      let request = task["request"] as? String ?? ""
      var taskRuns: [[String: Any]] = []
      for k in 0..<runs {
        taskRuns.append(try await runOnce(id: id, request: request, model: model, service: service, graph: graph))
        let run = taskRuns[k]
        let failed = (run["checks"] as? [[String: Any]] ?? []).filter { $0["pass"] as? Bool == false }
        let why = run["error"] as? String ?? failed.map { "\($0["name"] ?? ""): \($0["why"] ?? "")" }.joined(separator: "; ")
        print("\(id) #\(k + 1): \(run["pass"] as? Bool == true ? "pass" : "FAIL") \(why)")
      }
      taskResults.append(["id": id, "request": request, "runs": taskRuns])
    }
    results["tasks"] = taskResults

    let folder = URL(filePath: "apple/evals/results")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let stamp = ISO8601DateFormatter().string(from: .now).replacing(":", with: "")
    let file = folder.appending(path: "\(stamp)-\(model.name).json")
    try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: file)
    print("\nSaved \(file.relativePath)\n")
    print(try service.request(["cmd": "report", "path": file.path])["text"] as? String ?? "")
  }

  /// One task, once: a fresh graph and conversation, the request, then the grade.
  static func runOnce(
    id: String, request: String, model: any EvalModel, service: Service, graph: ServiceGraph
  ) async throws -> [String: Any] {
    let start = try service.request(["cmd": "start", "task": id])
    let rows = start["rows"] as? [String] ?? []
    let statusData = try JSONSerialization.data(withJSONObject: start["status"] ?? [])
    let status = try JSONDecoder().decode([RowStatus].self, from: statusData)
    let prompt = ChatModel.prompt(request, rows: rows, status: status)
    let began = ContinuousClock.now
    var turn = Turn(reply: "")
    var failure: String?
    do {
      turn = try await withThrowingTaskGroup(of: Turn.self) { group in
        group.addTask { try await model.respond(to: prompt, graph: graph) }
        group.addTask {
          try await Task.sleep(for: timeout)
          throw RunnerError("timed out")
        }
        defer { group.cancelAll() }
        return try await group.next()!
      }
    } catch LanguageModelError.contextSizeExceeded {
      failure = "context size exceeded"
    } catch {
      failure = String(describing: error).prefix(300).description
    }
    let elapsed = ContinuousClock.now - began
    var result = try service.request(["cmd": "grade", "reply": turn.reply])
    result["reply"] = turn.reply
    result["seconds"] = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
    if let tokens = turn.inputTokens { result["inputTokens"] = tokens }
    if let tokens = turn.outputTokens { result["outputTokens"] = tokens }
    if let failure {
      // The person sees an error instead of an answer: a failed run, whatever the graph shows.
      result["error"] = failure
      result["pass"] = false
    }
    return result
  }
}
