use js_component_bindgen::{transpile, InstantiationMode, TranspileOpts, Transpiled};
use wasmtime_environ::component::Export as WasmtimeExport;

wit_bindgen::generate!({
    world: "usuba-compat"
});

pub struct Polyfill;

impl Guest for Polyfill {
    fn polyfill(component: Vec<u8>, options: PolyfillOptions) -> Result<Artifacts, String> {
        let options = TranspileOpts {
            name: options.name,
            map: options
                .mappings
                .map(|mappings| mappings.into_iter().collect()),
            no_typescript: true,
            instantiation: options
                .instantiation
                .unwrap_or_else(|| Instantiation::Automatic)
                .into(),
            import_bindings: None,
            no_nodejs_compat: true,
            base64_cutoff: 1024,
            tla_compat: false,
            valid_lifting_optimization: false,
            tracing: false,
            no_namespaced_exports: true,
            multi_memory: false,
        };

        transpile(&component, options)
            .map(|transpiled| transpiled.into())
            .map_err(|error| format!("{}", error))
    }

    fn hash(bytes: Vec<u8>) -> String {
        blake3::hash(&bytes).to_string()
    }
}

export!(Polyfill);

impl From<Instantiation> for Option<InstantiationMode> {
    fn from(value: Instantiation) -> Self {
        match value {
            Instantiation::Automatic => None,
            Instantiation::Manual => Some(InstantiationMode::Async),
        }
    }
}

impl From<Transpiled> for Artifacts {
    fn from(value: Transpiled) -> Self {
        Artifacts {
            imports: value.imports,
            exports: value
                .exports
                .into_iter()
                .map(|(name, export)| {
                    let export_type = match export {
                        WasmtimeExport::LiftedFunction { .. } => ExportType::Function,
                        WasmtimeExport::Instance { .. } => ExportType::Instance,
                        _ => panic!("Unexpected export type"),
                    };
                    (name, export_type)
                })
                .collect(),
            files: value.files,
        }
    }
}
