import EquationCore
import Foundation

// States on the drawing side (web/session.ts `currentConstEnv`, `orbitFor`).
//
// A graph is a pure function of its rows; a state system's run is not. The
// run is an EquationCore `StateStepper`, owned by whoever draws frames: each
// frame it is advanced to the frame's time and handed to `overlay(at:run:)`
// and `scene(at:…run:)`, whose uniforms and CPU-drawn rows then read the
// states where the run has them. Without a run every state is at its start,
// which is the picture at t = 0.
//
// An orbit (`p(0..50)`) reads nothing that moves, so it is integrated once,
// when the graph is made. The site integrates in a worker and draws the row
// empty until it lands; here the first frame already has it.

extension Graph2D {
  /// Each orbit row's polyline, and what the site reports on the row of one
  /// that cannot be integrated (web/main.ts sets the row's error as it draws).
  static func orbits(_ analysis: DocumentAnalysis) -> (paths: [Int: [Double]], errors: [Int: String]) {
    var paths: [Int: [Double]] = [:]
    var errors: [Int: String] = [:]
    for (index, row) in analysis.rows.enumerated() {
      guard row.error == nil, row.unsupported == nil, case .orbit? = row.cpu else { continue }
      do {
        paths[index] = try analysis.orbit(row: index)
      } catch let error as LanguageError {
        errors[index] = error.message
      } catch {
        errors[index] = "\(error)"
      }
    }
    return (paths, errors)
  }

  /// The constants' values on a frame at `time`, the states where `run` has them.
  public func environment(at time: Double, run: StateStepper?) -> [String: Double] {
    run?.environment(at: time) ?? environment(at: time)
  }
}

extension StateStepper {
  /// Step to `time` as frames would have, 60 a second from where the run
  /// is: a picture of the graph at a time (metal-shot's `--time`) is then the
  /// run a viewer watching since t = 0 would be looking at.
  public mutating func play(to time: Double, framesPerSecond: Double = 60) {
    guard time > self.time, framesPerSecond > 0 else {
      advance(to: time)
      return
    }
    let start = self.time
    let frames = Int(((time - start) * framesPerSecond).rounded(.down))
    for frame in 0..<frames { advance(to: start + Double(frame + 1) / framesPerSecond) }
    advance(to: time)
  }
}
