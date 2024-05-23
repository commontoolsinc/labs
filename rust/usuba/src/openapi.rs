use utoipa::OpenApi;

use crate::{
    routes::{BuildModuleRequest, BuildModuleResponse},
    ErrorResponse,
};

#[derive(OpenApi)]
#[openapi(
    paths(crate::routes::build_module, crate::routes::retrieve_module),
    components(
        schemas(BuildModuleResponse),
        schemas(ErrorResponse),
        schemas(BuildModuleRequest)
    )
)]
pub struct OpenApiDocs;
