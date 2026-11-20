/// What each name of a document is bound to (lib/env.ts `Binding`, as
/// lib/defs.ts `buildDefs` binds the names of its stores): the tag Ask's row
/// report words a definition by (lib/assistant-tools.ts `definitionMeaning`).
public enum NameBinding: Equatable, Sendable {
  public enum Role: String, Equatable, Sendable {
    /// A value with no position: a number, a named point or vector.
    case constant = "const"
    /// A value at every point: it reaches x, y or z (or u, v).
    case field
    /// Integrated forward in time from its derivative (`a' = …`).
    case state
    /// `a = e^(i pi/3)`: a complex number with a name.
    case complex
    /// `within = r < R`: an inequality with a name.
    case condition
  }

  case scalar(Role)
  /// A point, a vector, a vector field or a vector state of `dim`
  /// components. `point`: a named point, drawn on the graph.
  case vector(Role, dim: Int, point: Bool)
  case function
  case matrix
  case tensor(shape: [Int])
  /// A list, a tuple, or a family of states (one run per starting value).
  case list
  /// A multivector, a line, plane or motor of projective geometry, or
  /// (`quaternion`) a quaternion.
  case multivector(quaternion: Bool)
  /// A continuous interval: one hidden parameter shared by every row that uses the name.
  case interval
}

/// The binding of every name the definitions hold. A vector owns its
/// components (`A_x`, `p_1`), which have no binding of their own.
func nameBindings(_ defs: BuiltDefs) -> [String: NameBinding] {
  var out: [String: NameBinding] = [:]
  // A point's or a vector field's components, by the name that owns them.
  var owners: [String: String] = [:]
  for (owner, dim) in defs.pointDims {
    for comp in pointComps(owner, dim) { owners[comp] = owner }
  }
  for (role, store) in [(NameBinding.Role.constant, defs.consts), (.field, defs.fields)] {
    for name in store.keys {
      guard let owner = owners[name] else {
        out[name] = .scalar(role)
        continue
      }
      if out[owner] == nil {
        out[owner] = .vector(role, dim: defs.pointDims[owner] ?? 2, point: defs.points.contains(owner))
      }
    }
  }
  var stateOwners: [String: String] = [:]
  for (owner, dim) in defs.vecStates {
    for comp in vecStateComps(owner, dim) { stateOwners[comp] = owner }
  }
  for name in defs.states.keys {
    if let owner = stateOwners[name] {
      out[owner] = .vector(.state, dim: defs.vecStates[owner] ?? 2, point: false)
    } else {
      out[name] = .scalar(.state)
    }
  }
  for name in defs.complexes.keys { out[name] = .scalar(.complex) }
  for name in defs.conditions.keys { out[name] = .scalar(.condition) }
  for name in defs.fns.keys { out[name] = .function }
  for name in defs.mats.keys { out[name] = .matrix }
  for (name, tensor) in defs.tensors.entries { out[name] = .tensor(shape: tensor.shape) }
  for name in defs.intervals.keys { out[name] = .interval }
  for (name, value) in defs.multivectors.entries {
    out[name] = .multivector(quaternion: mvOfNode(value)?.quat == true)
  }
  // (A family of states is the list of its runs.)
  for name in defs.lists.keys { out[name] = .list }
  return out
}

/// Whether a row is written as one that frames its panel: `view(…)`,
/// `camera(…)`, `grid(…)`, `on(…)` or a `---` divider. What Ask's report asks
/// of a row the port cannot read, which the site would not count among the
/// rows that use a name.
public func isFramingRow(_ text: String) -> Bool {
  let math = jsTrimmed(stripNote(text))
  return viewHead(math) != nil || isDividerRow(math)
}
