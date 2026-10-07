// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "EquationCore",
  platforms: [.macOS(.v15), .iOS(.v18)],
  products: [
    .library(name: "EquationCore", targets: ["EquationCore"])
  ],
  targets: [
    // The language core: no Foundation, so it also builds for WebAssembly.
    .target(name: "EquationCore"),
    .testTarget(
      name: "EquationCoreTests",
      dependencies: ["EquationCore"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
