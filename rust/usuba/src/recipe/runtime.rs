use wasmtime::component::{Component, Linker};
use wasmtime::{Engine, Store};

use crate::common::exports::common::module::module::GuestBody;
use crate::{Bake, Baker, UsubaError};

use super::common::Common;
pub use super::common::{Dictionary, InputOutput, ModuleEnvironment, Value};

const COMMON_MODULE_WIT: &[u8] =
    include_bytes!("../../../../typescript/common/module/wit/module.wit");

const COMMON_IO_WIT: &[u8] = include_bytes!("../../../../typescript/common/io/wit/io.wit");

const COMMON_DATA_WIT: &[u8] = include_bytes!("../../../../typescript/common/data/wit/data.wit");

pub struct Runtime {}

impl Runtime {
    pub async fn eval<Io: InputOutput + 'static>(
        &mut self,
        content_type: String,
        source_code: String,
        io: Io,
    ) -> Result<Io, UsubaError> {
        let component_baker = match content_type.as_str() {
            "text/javascript" => Baker::JavaScript,
            "text/x-python" => Baker::Python,
            _ => return Err(UsubaError::BadRequest),
        };

        let component_wasm = component_baker
            .bake(
                "common",
                vec![COMMON_MODULE_WIT.into()],
                source_code.into(),
                vec![COMMON_DATA_WIT.into(), COMMON_IO_WIT.into()],
            )
            .await?;

        let mut config = wasmtime::Config::default();
        config.async_support(false);

        let engine = Engine::new(&config)?;

        let mut store = Store::new(&engine, ModuleEnvironment::new(io));

        let component = Component::new(&engine, component_wasm)?;
        let mut linker = Linker::new(&engine);

        wasmtime_wasi::add_to_linker_sync(&mut linker)?;

        Common::add_to_linker(&mut linker, |environment| environment)?;

        let (common, _inst) = Common::instantiate(&mut store, &component, &linker)?;

        let store = tokio::task::spawn_blocking(move || {
            let common_module = common.common_module_module();

            match common_module.call_create(&mut store) {
                Ok(body_resource) => {
                    common
                        .common_module_module()
                        .body()
                        .call_run(&mut store, body_resource)?;
                }
                Err(error) => {
                    error!("Create failed: {}", error);
                }
            };

            Ok(store) as wasmtime::Result<Store<ModuleEnvironment<Io>>, wasmtime::Error>
        })
        .await??;

        Ok(store.into_data().take_io())
    }
}
