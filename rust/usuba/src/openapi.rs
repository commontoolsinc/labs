use utoipa::OpenApi;

use crate::{
    routes::{BuildModuleRequest, BuildModuleResponse, BundleRequest},
    ErrorResponse,
};

#[derive(OpenApi)]
#[openapi(
    paths(
        crate::routes::build_module,
        crate::routes::retrieve_module,
        crate::routes::bundle_javascript
    ),
    components(
        schemas(BuildModuleResponse),
        schemas(ErrorResponse),
        schemas(BuildModuleRequest),
        schemas(BundleRequest)
    )
)]
pub struct OpenApiDocs;
