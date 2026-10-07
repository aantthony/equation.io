import os

/// Milestones in opening a document, for finding what makes it slow:
///
///   xcrun simctl spawn booted log stream --level debug \
///     --predicate 'subsystem == "io.equation.app"'
let timing = Logger(subsystem: "io.equation.app", category: "timing")
