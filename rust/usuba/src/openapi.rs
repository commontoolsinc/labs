use utoipa::OpenApi;

use crate::{
    routes::{
        BuildModuleRequest, BuildModuleResponse, BundleRequest, EvalRecipeRequest,
        EvalRecipeResponse, JsonValue,
    },
    ErrorResponse,
};

#[derive(OpenApi)]
#[openapi(
    paths(
        crate::routes::build_module,
        crate::routes::retrieve_module,
        crate::routes::bundle_javascript,
        crate::routes::eval_recipe,
        crate::routes::verify
    ),
    components(
        schemas(BuildModuleResponse),
        schemas(ErrorResponse),
        schemas(BuildModuleRequest),
        schemas(BundleRequest),
        schemas(EvalRecipeRequest),
        schemas(EvalRecipeResponse),
        schemas(JsonValue)
    )
)]
pub struct OpenApiDocs;
