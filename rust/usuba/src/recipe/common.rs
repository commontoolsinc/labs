use std::collections::BTreeMap;

use wasmtime::{
    component::{bindgen, Resource},
    Module,
};

bindgen!({
  world: "common",
  path: "../../typescript/common/module/wit"
});

pub use common::data::types::{Dictionary, Reference, Value};
use wasmtime_wasi::WasiView;

pub trait InputOutput: Send + Sync + Clone + std::fmt::Debug {
    fn read(&self, key: &str) -> Option<Value>;
    fn write(&mut self, key: &str, value: Value);
}

pub struct ResourceTable<T> {
    next_index: u32,
    resources: BTreeMap<u32, T>,
}

impl<T> ResourceTable<T> {
    pub fn add(&mut self, resource: T) -> u32 {
        let index = self.next_index;

        self.next_index = self.next_index + 1;
        self.resources.insert(index, resource);

        index
    }

    pub fn lookup(&self, index: u32) -> Option<&T> {
        self.resources.get(&index)
    }

    pub fn remove(&mut self, index: u32) {
        self.resources.remove(&index);
    }
}

impl<T> Default for ResourceTable<T> {
    fn default() -> Self {
        Self {
            next_index: Default::default(),
            resources: BTreeMap::new(),
        }
    }
}

#[repr(transparent)]
pub struct HostReference(String);

pub struct ModuleEnvironment<Io>
where
    Io: InputOutput,
{
    io: Io,
    references: ResourceTable<HostReference>,

    wasi_resources: wasmtime_wasi::ResourceTable,
    wasi_ctx: wasmtime_wasi::WasiCtx,
}

impl<Io> ModuleEnvironment<Io>
where
    Io: InputOutput,
{
    pub fn new(io: Io) -> Self {
        ModuleEnvironment {
            io,
            references: ResourceTable::default(),

            wasi_resources: wasmtime_wasi::ResourceTable::new(),
            wasi_ctx: wasmtime_wasi::WasiCtx::builder().build(),
        }
    }

    pub fn take_io(self) -> Io {
        self.io
    }
}

impl<Io> common::io::state::Host for ModuleEnvironment<Io>
where
    Io: InputOutput,
{
    fn read(&mut self, name: String) -> Option<Resource<Reference>> {
        warn!("Reading input: {name}");
        if self.io.read(&name).is_none() {
            return None;
        }

        let reference = HostReference(name);
        let index = self.references.add(reference);

        Some(Resource::new_own(index))
    }

    fn write(&mut self, name: String, value: Value) -> () {
        warn!("Writing output: {name}");
        self.io.write(&name, value);
    }
}

impl<Io> common::data::types::HostDictionary for ModuleEnvironment<Io>
where
    Io: InputOutput,
{
    fn get(
        &mut self,
        _resource: Resource<Dictionary>,
        _key: String,
    ) -> Option<wasmtime::component::Resource<Reference>> {
        unimplemented!("Dictionary not supported yet saaawiii");
    }

    fn drop(&mut self, _rep: Resource<Dictionary>) -> wasmtime::Result<()> {
        unimplemented!("Dictionary not supported yet saaawiii");
    }
}

impl<Io> common::data::types::HostReference for ModuleEnvironment<Io>
where
    Io: InputOutput,
{
    /// Dereference a reference to a value
    /// This call is fallible (for example, if the dereference is not allowed)
    /// The value may be none (for example, if it is strictly opaque)
    fn deref(&mut self, resource: Resource<Reference>) -> Result<Option<Value>, String> {
        let HostReference(key) = self
            .references
            .lookup(resource.rep())
            .ok_or_else(|| String::from("Attempted to deref an untracked Reference"))?;

        Ok(self.io.read(key))
    }

    fn drop(&mut self, rep: Resource<Reference>) -> wasmtime::Result<()> {
        Ok(self.references.remove(rep.rep()))
    }
}

impl<Io> common::data::types::Host for ModuleEnvironment<Io> where Io: InputOutput {}

impl<Io> WasiView for ModuleEnvironment<Io>
where
    Io: InputOutput,
{
    fn table(&mut self) -> &mut wasmtime_wasi::ResourceTable {
        &mut self.wasi_resources
    }

    fn ctx(&mut self) -> &mut wasmtime_wasi::WasiCtx {
        &mut self.wasi_ctx
    }
}
