// import gleam/io
// import gleam/string

// FFI declaration - this calls the JavaScript function in space.ts
@external(javascript, "../../../../../space.ts", "select_ffi")
fn select_ffi_impl(session: a, args: b) -> Result(c, String)

// Public wrapper with debug logging
pub fn select_gleam(session: a, args: b) -> Result(c, String) {
  let result = select_ffi_impl(session, args)
  // io.println("Gleam: result = " <> string.inspect(result))
  result
}
