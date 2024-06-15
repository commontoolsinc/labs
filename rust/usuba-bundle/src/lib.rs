#[macro_use]
extern crate tracing;

use anyhow::{anyhow, Result};
use bytes::Bytes;
use deno_emit::{
    bundle, BundleOptions, BundleType, EmitOptions, LoadFuture, LoadOptions, Loader,
    ModuleSpecifier, SourceMapOption, TranspileOptions,
};
use deno_graph::source::LoadResponse;
use url::Url;

pub struct JavaScriptLoader {
    root: Option<Bytes>,
}

impl JavaScriptLoader {
    pub fn new(root: Option<Bytes>) -> Self {
        Self { root }
    }
}

impl Loader for JavaScriptLoader {
    fn load(&self, specifier: &ModuleSpecifier, _options: LoadOptions) -> LoadFuture {
        let root = self.root.clone();
        let specifier = specifier.clone();

        debug!("Attempting to load '{}'", specifier);

        Box::pin(async move {
            match specifier.scheme() {
                "usuba" => {
                    debug!("Usuba!");
                    Ok(Some(LoadResponse::Module {
                        content: root
                            .ok_or_else(|| {
                                anyhow!("Attempted to load root module, but no root was specified!")
                            })?
                            .to_vec()
                            .into(),
                        specifier,
                        maybe_headers: None,
                    }))
                }
                "common" => {
                    debug!("Common!");
                    Ok(Some(LoadResponse::External {
                        specifier: specifier.clone(),
                    }))
                }
                "https" => {
                    debug!("Https!");
                    let response = reqwest::get(specifier.clone()).await?;
                    let headers = response.headers().to_owned();
                    let bytes = response.bytes().await?;
                    let content = bytes.to_vec().into();

                    trace!("Loaded remote module: {}", String::from_utf8_lossy(&bytes));
                    Ok(Some(LoadResponse::Module {
                        content,
                        specifier,
                        maybe_headers: Some(
                            headers
                                .into_iter()
                                .filter_map(|(h, v)| {
                                    h.map(|header| {
                                        (
                                            header.to_string(),
                                            v.to_str().unwrap_or_default().to_string(),
                                        )
                                    })
                                })
                                .collect(),
                        ),
                    }))
                }
                "node" | "npm" => Err(anyhow!(
                    "Could not import '{specifier}'. Node.js and NPM modules are not supported."
                )),
                _ => Err(anyhow!(
                    "Could not import '{specifier}'. Unrecognize specifier format.'"
                )),
            }
        })
    }
}

pub struct JavaScriptBundler {}

impl JavaScriptBundler {
    fn bundle_options() -> BundleOptions {
        BundleOptions {
            bundle_type: BundleType::Module,
            transpile_options: TranspileOptions::default(),
            emit_options: EmitOptions {
                source_map: SourceMapOption::None,
                source_map_file: None,
                inline_sources: false,
                remove_comments: true,
            },
            emit_ignore_directives: false,
            minify: false,
        }
    }

    pub async fn bundle_url(url: Url) -> Result<String> {
        let mut loader = JavaScriptLoader::new(None);
        let emit = bundle(url, &mut loader, None, Self::bundle_options()).await?;
        Ok(emit.code)
    }

    pub async fn bundle_module(module: Bytes) -> Result<String> {
        let mut loader = JavaScriptLoader::new(Some(module));
        let emit = bundle(
            Url::parse("usuba:root")?,
            &mut loader,
            None,
            Self::bundle_options(),
        )
        .await?;
        Ok(emit.code)
    }
}

#[cfg(test)]
pub mod tests {
    use anyhow::Result;
    use url::Url;

    use crate::JavaScriptBundler;

    #[tokio::test]
    async fn it_loads_a_module_from_esm_sh() -> Result<()> {
        let candidate = Url::parse("https://esm.sh/canvas-confetti@1.6.0")?;
        let bundle = JavaScriptBundler::bundle_url(candidate).await?;

        assert!(bundle.len() > 0);

        Ok(())
    }

    #[tokio::test]
    async fn it_loads_a_module_from_deno_land() -> Result<()> {
        let candidate = Url::parse("https://deno.land/x/zod@v3.16.1/mod.ts")?;
        let bundle = JavaScriptBundler::bundle_url(candidate).await?;

        assert!(bundle.len() > 0);

        Ok(())
    }

    #[tokio::test]
    async fn it_can_bundle_a_module_file() -> Result<()> {
        let candidate = format!(
            r#"export * from "https://esm.sh/canvas-confetti@1.6.0";
"#
        );
        let bundle = JavaScriptBundler::bundle_module(candidate.into()).await?;

        assert!(bundle.len() > 0);

        Ok(())
    }

    #[tokio::test]
    async fn it_skips_common_modules_when_bundling() -> Result<()> {
        let candidate = format!(
            r#"
import {{ read, write }} from "common:io/state@0.0.1";

// Note: must use imports else they are tree-shaken
// Caveat: cannot re-export built-ins as it provokes bundling
console.log(read, write);
"#
        );

        let bundle = JavaScriptBundler::bundle_module(candidate.into())
            .await
            .map_err(|error| {
                error!("{}", error);
                error
            })
            .unwrap();

        debug!("{bundle}");

        assert!(bundle.contains("import { read, write } from \"common:io/state@0.0.1\""));

        Ok(())
    }
}
