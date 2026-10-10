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
//   pnpm app:eval --sampling greedy        # as the app answers (ChatModel.options); default: sampled
//
//   pnpm app:eval --model openai          # a hosted baseline (gpt-5.5; --openai-model to change)
//   pnpm app:eval --model openai --reference web/public/llms.txt
//                                          # the whole reference in its instructions, in place
//                                          # of the lookup tools (too long for the device's 8K)
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
  /// The rows now, and each one's status as the app's renderer reports it.
  func state() throws -> (rows: [String], status: [RowStatus]) {
    let answer = try service.request(["cmd": "status"])
    let data = try JSONSerialization.data(withJSONObject: answer["status"] ?? [])
    return (answer["rows"] as? [String] ?? [], try JSONDecoder().decode([RowStatus].self, from: data))
  }
  func listKinds() async -> String { tool("list_kinds", [:]) }
  func kindExamples(_ kind: String) async -> String { tool("kind_examples", ["kind": kind]) }
  func shape(_ name: String) async -> String { tool("shape", ["name": name]) }
  func searchFunctions(_ query: String) async -> String { tool("search_functions", ["query": query]) }
  func functionDoc(_ name: String) async -> String { tool("function_doc", ["name": name]) }
}

// MARK: - Models

/// One request's answer: the reply, and the tokens it took where the model says.
struct Turn {
  var reply: String
  var inputTokens: Int?
  var outputTokens: Int?
  /// Of the input, tokens the API served from its prompt cache (billed less).
  var cachedInputTokens: Int?
  /// Of the output, tokens spent reasoning rather than replying or calling tools.
  var reasoningTokens: Int?
  /// The model's exact id, where the API names it (e.g. a dated snapshot).
  var modelID: String?
  /// The follow-up about rows with an error (ChatModel.followUp), if one was
  /// sent, and whether the rows were free of errors after it.
  var followUp: String?
  var followUpFixed: Bool?
}

/// A model the evals can run: the app's (on-device), or a hosted baseline.
protocol EvalModel: Sendable {
  var name: String { get }
  /// Gives up on a run that takes longer than this (a model stuck calling tools).
  var timeout: Duration { get }
  /// A fresh conversation's answer to one request, using the app's tools on `graph`.
  func respond(to prompt: String, graph: any GraphTools) async throws -> Turn
}

extension EvalModel {
  var timeout: Duration { .seconds(180) }
}

/// How many tool calls a run may make before it fails. The on-device model
/// can retry a failing set_graph until its context overflows, which takes
/// minutes; a passing run has needed 12 calls at most. Only the evals stop
/// there: the app sets no limit.
let toolCallLimit = 12

struct TooManyToolCalls: Error, CustomStringConvertible {
  var description: String { "more than \(toolCallLimit) tool calls" }
}

/// One run's tool calls so far.
@MainActor final class ToolBudget {
  private var used = 0

  func spend() throws {
    used += 1
    if used > toolCallLimit { throw TooManyToolCalls() }
  }
}

/// One of the app's tools, its calls counted against a run's budget.
struct Capped<Base: Tool>: Tool {
  typealias Arguments = Base.Arguments
  typealias Output = Base.Output
  let base: Base
  let budget: ToolBudget

  var name: String { base.name }
  var description: String { base.description }
  var parameters: GenerationSchema { base.parameters }
  var includesSchemaInInstructions: Bool { base.includesSchemaInInstructions }

  func call(arguments: Arguments) async throws -> Output {
    try await budget.spend()
    return try await base.call(arguments: arguments)
  }
}

/// The app's tools for one run, sharing one budget.
func cappedTools(_ graph: any GraphTools) -> [any Tool] {
  let budget = ToolBudget()
  func cap<T: Tool>(_ tool: T) -> any Tool { Capped(base: tool, budget: budget) }
  return ChatModel.tools(graph).map { cap($0) }
}

/// How the on-device model picks tokens in the evals. The app is greedy
/// (ChatModel.options), so a request always gets the same answer; sampled
/// runs differ, which turns a task's pass into a rate over its runs.
enum Sampling: String {
  case `default`, greedy

  var options: GenerationOptions {
    switch self {
    case .default: GenerationOptions()
    case .greedy: ChatModel.options
    }
  }
}

/// Apple's on-device model, as the app's Ask uses it (never Private Cloud Compute here).
struct OnDeviceModel: EvalModel {
  let name = "on-device"
  var sampling = Sampling.default

  func respond(to prompt: String, graph: any GraphTools) async throws -> Turn {
    let session = LanguageModelSession(
      model: SystemLanguageModel.default, tools: cappedTools(graph), instructions: ChatModel.instructions)
    var turn = Turn(reply: try await session.respond(to: prompt, options: sampling.options).content)
    // As the app does (Chat.swift): one follow-up, in the same session, if a row has an error.
    // The session's tools share one budget, so the call cap covers both requests.
    if let service = graph as? ServiceGraph {
      let (rows, status) = try await service.state()
      if let followUp = ChatModel.followUp(rows: rows, status: status) {
        turn.followUp = followUp
        turn.reply = try await session.respond(to: followUp, options: sampling.options).content
        let after = try await service.state()
        turn.followUpFixed = ChatModel.followUp(rows: after.rows, status: after.status) == nil
      }
    }
    turn.inputTokens = session.usage.input.totalTokenCount
    turn.outputTokens = session.usage.output.totalTokenCount
    return turn
  }
}

/// An OpenAI model through Chat Completions, as a hosted baseline: the app's
/// instructions, and its tools with their schemas (each tool's @Generable
/// arguments, encoded as JSON Schema) and their own code, so a call is
/// trimmed and clamped as in the app. With a `reference`, the instructions
/// are referenceInstructions followed by the whole reference, and the
/// lookup tools are left out.
struct OpenAIModel: EvalModel {
  let model: String
  let key: String
  var reference: String?
  var name: String { "openai-\(model)\(reference == nil ? "" : "-reference")" }
  /// The tools a model with the reference in its instructions keeps: the graph's, and check.
  static let referenceTools: Set<String> = ["get_graph", "set_graph", "move_view", "animate_slider", "check"]
  // Hosted reasoning takes longer a round than the device; a stuck run still ends.
  var timeout: Duration { .seconds(600) }
  /// Model calls in one request; a run still calling tools after this many fails.
  let maxRounds = 20

  func respond(to prompt: String, graph: any GraphTools) async throws -> Turn {
    let tools = cappedTools(graph).filter { reference == nil || Self.referenceTools.contains($0.name) }
    let instructions = reference.map { "\(ChatModel.referenceInstructions)\n\n\($0)" } ?? ChatModel.instructions
    var messages: [[String: Any]] = [
      ["role": "system", "content": instructions], ["role": "user", "content": prompt],
    ]
    var turn = Turn(reply: "", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0)
    for _ in 0..<maxRounds {
      let body: [String: Any] = ["model": model, "messages": messages, "tools": try tools.map(Self.function)]
      let response = try await post(body)
      let usage = response["usage"] as? [String: Any] ?? [:]
      turn.inputTokens! += usage["prompt_tokens"] as? Int ?? 0
      turn.outputTokens! += usage["completion_tokens"] as? Int ?? 0
      turn.cachedInputTokens! += (usage["prompt_tokens_details"] as? [String: Any])?["cached_tokens"] as? Int ?? 0
      turn.reasoningTokens! += (usage["completion_tokens_details"] as? [String: Any])?["reasoning_tokens"] as? Int ?? 0
      turn.modelID = response["model"] as? String
      guard let message = ((response["choices"] as? [[String: Any]])?.first)?["message"] as? [String: Any] else {
        throw RunnerError("no message in the response")
      }
      let calls = message["tool_calls"] as? [[String: Any]] ?? []
      if calls.isEmpty {
        turn.reply = message["content"] as? String ?? ""
        return turn
      }
      messages.append(message.filter { $0.value is NSNull == false })
      // In the order given: a slider has to exist before it's animated.
      for call in calls {
        let function = call["function"] as? [String: Any] ?? [:]
        let name = function["name"] as? String ?? ""
        let arguments = function["arguments"] as? String ?? "{}"
        var output: String
        if let tool = tools.first(where: { $0.name == name }) {
          do {
            output = try await Self.call(tool, arguments)
          } catch let error as TooManyToolCalls {
            throw error
          } catch {
            output = #"{"error":"\#(error)"}"#
          }
        } else {
          output = #"{"error":"no tool named \#(name)"}"#
        }
        messages.append(["role": "tool", "tool_call_id": call["id"] as? String ?? "", "content": output])
      }
    }
    throw RunnerError("still calling tools after \(maxRounds) rounds")
  }

  /// A tool as Chat Completions takes it: name, description, and the argument schema.
  static func function(_ tool: any Tool) throws -> [String: Any] {
    var schema = try JSONSerialization.jsonObject(with: JSONEncoder().encode(tool.parameters)) as? [String: Any] ?? [:]
    // FoundationModels' own keys; the API doesn't need them.
    schema["title"] = nil
    schema["x-order"] = nil
    return ["type": "function", "function": ["name": tool.name, "description": tool.description, "parameters": schema]]
  }

  /// Runs the app's tool on the model's JSON arguments.
  static func call<T: Tool>(_ tool: T, _ json: String) async throws -> String {
    let output = try await tool.call(arguments: T.Arguments(GeneratedContent(json: json)))
    return output as? String ?? "\(output)"
  }

  /// One Chat Completions request, retried with backoff on rate limits, server errors and dropped connections.
  func post(_ body: [String: Any]) async throws -> [String: Any] {
    var request = URLRequest(url: URL(string: "https://api.openai.com/v1/chat/completions")!)
    request.httpMethod = "POST"
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    request.timeoutInterval = 300
    var attempt = 0
    while true {
      attempt += 1
      var wait = min(60, pow(2, Double(attempt)))
      do {
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 200, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] { return object }
        let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
          .flatMap { ($0["error"] as? [String: Any])?["message"] as? String } ?? "HTTP \(status)"
        guard status == 429 || status >= 500, attempt < 8 else { throw RunnerError("OpenAI: \(message)") }
        if let after = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "retry-after").flatMap(Double.init) {
          wait = max(wait, after)
        }
        FileHandle.standardError.write(Data("OpenAI \(status), retrying in \(Int(wait)) s\n".utf8))
      } catch let error as URLError where attempt < 8 {
        FileHandle.standardError.write(Data("OpenAI \(error.code.rawValue), retrying in \(Int(wait)) s\n".utf8))
      }
      try await Task.sleep(for: .seconds(wait))
    }
  }

  /// OPENAI_API_KEY from the environment, or from the checkout's .dev.vars
  /// (gitignored; a worktree reads the main checkout's).
  static func key() throws -> String {
    if let key = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], !key.isEmpty { return key }
    let git = Process()
    let out = Pipe()
    git.executableURL = URL(filePath: "/usr/bin/env")
    git.arguments = ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]
    git.standardOutput = out
    try? git.run()
    git.waitUntilExit()
    let common = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    var files = [URL(filePath: ".dev.vars")]
    if !common.isEmpty { files.append(URL(filePath: common).deletingLastPathComponent().appending(path: ".dev.vars")) }
    for file in files {
      guard let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
      for line in text.split(whereSeparator: \.isNewline) where line.hasPrefix("OPENAI_API_KEY=") {
        let key = line.dropFirst("OPENAI_API_KEY=".count).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
        if !key.isEmpty { return key }
      }
    }
    throw RunnerError("set OPENAI_API_KEY, or add it to .dev.vars")
  }
}

enum ModelChoice: String {
  case onDevice = "on-device"
  case openAI = "openai"

  func make(openAIModel: String, reference: String?, sampling: Sampling) throws -> any EvalModel {
    switch self {
    case .onDevice:
      guard reference == nil else { throw RunnerError("the reference doesn't fit the on-device model's 8K context") }
      return OnDeviceModel(sampling: sampling)
    case .openAI: return OpenAIModel(model: openAIModel, key: try OpenAIModel.key(), reference: reference)
    }
  }
}

// MARK: - Running

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
    var openAIModel = "gpt-5.5"
    var referencePath: String?
    var sampling = Sampling.default
    var arguments = CommandLine.arguments.dropFirst()
    while let flag = arguments.popFirst() {
      switch flag {
      case "--runs": runs = Int(arguments.popFirst() ?? "") ?? runs
      case "--task": only.append(arguments.popFirst() ?? "")
      case "--model":
        guard let model = ModelChoice(rawValue: arguments.popFirst() ?? "") else { throw RunnerError("unknown model") }
        choice = model
      case "--openai-model": openAIModel = arguments.popFirst() ?? openAIModel
      case "--reference": referencePath = arguments.popFirst()
      case "--sampling":
        guard let mode = Sampling(rawValue: arguments.popFirst() ?? "") else { throw RunnerError("unknown sampling") }
        sampling = mode
      default:
        throw RunnerError(
          "usage: runner [--runs N] [--task id]… [--model on-device|openai] [--openai-model id] [--reference llms.txt] [--sampling default|greedy]"
        )
      }
    }
    let reference = try referencePath.map { try String(contentsOfFile: $0, encoding: .utf8) }
    let model = try choice.make(openAIModel: openAIModel, reference: reference, sampling: sampling)
    let service = try Service()
    let graph = ServiceGraph(service)
    let all = try service.request(["cmd": "tasks"])["tasks"] as? [[String: Any]] ?? []
    let tasks = only.isEmpty ? all : all.filter { only.contains($0["id"] as? String ?? "") }

    var results: [String: Any] = [
      "model": model.name, "date": ISO8601DateFormatter().string(from: .now), "runs": runs,
      "knowledge": reference == nil ? "tools" : "reference",
    ]
    if let referencePath, let reference { results["reference"] = ["path": referencePath, "bytes": reference.utf8.count] }
    if choice == .onDevice {
      let system = SystemLanguageModel.default
      results["contextSize"] = system.contextSize
      results["instructionsTokens"] = try? await system.tokenCount(for: Instructions(ChatModel.instructions))
      results["toolsTokens"] = try? await system.tokenCount(for: ChatModel.tools(graph))
      results["sampling"] = sampling.rawValue
    }

    // Saved after every task, so a run cut short keeps what it finished ("partial": true until the end).
    let folder = URL(filePath: "apple/evals/results")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let stamp = ISO8601DateFormatter().string(from: .now).replacing(":", with: "")
    let file = folder.appending(path: "\(stamp)-\(model.name).json")
    var taskResults: [[String: Any]] = []
    func save(partial: Bool) throws {
      results["tasks"] = taskResults
      results["partial"] = partial ? true : nil
      // The snapshot the API answered with, e.g. gpt-5.5-2026-04-23.
      if let id = taskResults.flatMap({ $0["runs"] as? [[String: Any]] ?? [] }).lazy.compactMap({ $0["modelId"] }).first {
        results["modelId"] = id
      }
      try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: file)
    }
    for task in tasks {
      let id = task["id"] as? String ?? "?"
      let request = task["request"] as? String ?? ""
      var taskRuns: [[String: Any]] = []
      for k in 0..<runs {
        taskRuns.append(
          try await runOnce(
            id: id, request: request, variant: reference == nil ? "text" : "reference", model: model, service: service,
            graph: graph))
        let run = taskRuns[k]
        let failed = (run["checks"] as? [[String: Any]] ?? []).filter { $0["pass"] as? Bool == false }
        let why = run["error"] as? String ?? failed.map { "\($0["name"] ?? ""): \($0["why"] ?? "")" }.joined(separator: "; ")
        print("\(id) #\(k + 1): \(run["pass"] as? Bool == true ? "pass" : "FAIL") \(why)")
      }
      taskResults.append(["id": id, "request": request, "runs": taskRuns])
      try save(partial: true)
    }
    try save(partial: false)
    print("\nSaved \(file.relativePath)\n")
    print(try service.request(["cmd": "report", "path": file.path])["text"] as? String ?? "")
  }

  /// One task, once: a fresh graph and conversation, the request, then the grade.
  static func runOnce(
    id: String, request: String, variant: String, model: any EvalModel, service: Service, graph: ServiceGraph
  ) async throws -> [String: Any] {
    let start = try service.request(["cmd": "start", "task": id, "variant": variant])
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
          try await Task.sleep(for: model.timeout)
          throw RunnerError("timed out")
        }
        defer { group.cancelAll() }
        return try await group.next()!
      }
    } catch LanguageModelError.contextSizeExceeded {
      failure = "context size exceeded"
    } catch let error as LanguageModelSession.ToolCallError where error.underlyingError is TooManyToolCalls {
      failure = "\(error.underlyingError)"
    } catch let error as TooManyToolCalls {
      failure = "\(error)"
    } catch let error as LanguageModelSession.ToolCallError {
      // The tool's whole description would push out why its call failed.
      failure = "tool call \(error.tool.name): \(error.underlyingError)".prefix(300).description
    } catch {
      failure = String(describing: error).prefix(300).description
    }
    let elapsed = ContinuousClock.now - began
    var result = try service.request(["cmd": "grade", "reply": turn.reply])
    result["reply"] = turn.reply
    result["seconds"] = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
    if let tokens = turn.inputTokens { result["inputTokens"] = tokens }
    if let tokens = turn.outputTokens { result["outputTokens"] = tokens }
    if let tokens = turn.cachedInputTokens { result["cachedInputTokens"] = tokens }
    if let tokens = turn.reasoningTokens { result["reasoningTokens"] = tokens }
    if let id = turn.modelID { result["modelId"] = id }
    if let followUp = turn.followUp {
      var record: [String: Any] = ["message": followUp]
      if let fixed = turn.followUpFixed { record["fixed"] = fixed }
      result["followUp"] = record
    }
    if let failure {
      // The person sees an error instead of an answer: a failed run, whatever the graph shows.
      result["error"] = failure
      result["pass"] = false
    }
    return result
  }
}
