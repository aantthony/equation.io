import Foundation
import Testing

@testable import EquationCore

/// A run of a state system (States.swift `StateStepper`): what the corpus
/// cannot record, since the site keeps its run in the page.
@Suite struct StateStepping {
  @Test func aRunStepsDecaysAndRestarts() {
    let analysis = analyze(["a' = -a", "a(0) = 2", "P = (1, a)", "b = 2 a + t"])
    #expect(analysis.stateSystem?.names == ["a"])
    #expect(analysis.initialState == ["a": 2])
    #expect(analysis.env == ["a": 2, "P_x": 1, "P_y": 2, "b": 4])
    #expect(analysis.animated == ["P_y", "b"])
    var run = StateStepper(analysis)
    run.advance(to: 1)
    // A frame takes at most 60 steps: the rest of the second is dropped, and the clock kept.
    #expect(run.time == 1)
    #expect(abs(run.values["a"]! - 2 * exp(-0.25)) < 1e-9)
    for frame in 1...60 { run.advance(to: 1 + Double(frame) / 60) }
    #expect(abs(run.values["a"]! - 2 * exp(-1.25)) < 1e-2)
    // What reads the state follows it.
    let env = run.environment(at: 2)
    #expect(env["P_y"] == run.values["a"] && env["b"] == 2 * run.values["a"]! + 2)
    // Time running backwards starts the run again.
    run.advance(to: 0.5)
    #expect(run.values == ["a": 2] && run.time == 0.5)
  }

  @Test func aSystemThatBlowsUpHoldsItsLastGoodFrame() {
    var run = StateStepper(analyze(["a' = a^2", "a(0) = 1"]))
    for frame in 1...180 { run.advance(to: Double(frame) / 60) }
    #expect(run.values["a"]!.isFinite && run.values["a"]! > 100)
  }

  @Test func vectorStatesSplit() {
    let analysis = analyze(["r' = (r_2, -r_1)", "r(0) = (1, 0)", "r", "th' = om", "om' = r"])
    #expect(analysis.rows.allSatisfy { $0.error == nil && $0.unsupported == nil })
    #expect(Set(analysis.stateSystem?.names ?? []) == ["r_1", "r_2", "th_1", "th_2", "om_1", "om_2"])
    #expect(analysis.env["r_1"] == 1 && analysis.env["th_1"] == 0)
    #expect(analysis.rows[2].cpu?.type == "point")
  }
}
