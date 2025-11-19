import gleam/dict.{type Dict}
import gleam/list

// import gleam/int
// import gleam/io

// ===== Type Aliases =====

pub type URI =
  String

pub type MIME =
  String

pub type CauseString =
  String

// OfTheCause<T> is a triple-nested dict: URI -> MIME -> CauseString -> T
pub type OfTheCause(t) =
  Dict(URI, Dict(MIME, Dict(CauseString, t)))

pub type IterateEntry(t) {
  IterateEntry(of: URI, the: MIME, cause: CauseString, value: t)
}

// ===== iterate function =====

/// Pure Gleam implementation - works with Gleam Dict types
pub fn iterate_gleam(selection: OfTheCause(t)) -> List(IterateEntry(t)) {
  let result =
    selection
    |> dict.to_list
    |> list.flat_map(fn(of_entry) {
      let #(of, attributes) = of_entry
      attributes
      |> dict.to_list
      |> list.flat_map(fn(the_entry) {
        let #(the, causes) = the_entry
        causes
        |> dict.to_list
        |> list.map(fn(cause_entry) {
          let #(cause, value) = cause_entry
          IterateEntry(of: of, the: the, cause: cause, value: value)
        })
      })
    })

  // io.println(
  //   "Gleam iterate_gleam: returned " <> int.to_string(list.length(result)) <> " entries",
  // )
  result
}

/// Public API - converts JavaScript objects to Gleam Dicts, then calls pure version
/// This is the Gleam version of selection.ts:iterate
@external(javascript, "../../../../../space.ts", "iterate_js_wrapper")
pub fn iterate(selection: a) -> List(IterateEntry(b))

// ===== FFI for select (existing proof-of-concept) =====

// FFI declaration - this calls the JavaScript function in space.ts
@external(javascript, "../../../../../space.ts", "select_ffi")
fn select_ffi_impl(session: a, args: b) -> Result(c, String)

// Public wrapper with debug logging
pub fn select_gleam(session: a, args: b) -> Result(c, String) {
  let result = select_ffi_impl(session, args)
  result
}
