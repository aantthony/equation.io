// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "EquationCore",
  platforms: [.macOS(.v15), .iOS(.v18)],
  products: [
    .library(name: "EquationCore", targets: ["EquationCore"]),
    .library(name: "EquationRender", targets: ["EquationRender"]),
    .library(name: "EquationAssist", targets: ["EquationAssist"]),
  ],
  targets: [
    // The language core: no Foundation, so it also builds for WebAssembly.
    .target(name: "EquationCore"),
    // The Metal renderer: web/render2d.ts and web/render3d.ts, ported.
    .target(name: "EquationRender", dependencies: ["EquationCore"]),
    // Renders a graph to a PNG without the app, to set beside the site's
    // (apple/tools/web-shot.ts): swift run metal-shot --help
    .executableTarget(name: "metal-shot", dependencies: ["EquationCore", "EquationRender"]),
    .testTarget(
      name: "EquationCoreTests",
      dependencies: ["EquationCore"],
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "EquationRenderTests",
      dependencies: ["EquationCore", "EquationRender"],
      resources: [.copy("Scenes")]
    ),
    // Ask's lookups (lib/assistant-tools.ts), answered from data the app
    // bundles: Foundation only, and nothing of the language's.
    .target(name: "EquationAssist"),
    .testTarget(name: "EquationAssistTests", dependencies: ["EquationAssist"], resources: [.copy("Fixtures")]),
  ]
)
