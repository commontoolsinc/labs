use leptos::html::*;
use leptos::*;

#[derive(Clone, Debug, PartialEq)]
pub struct MicroAppIdea {
    pub title: String,
    pub spec: String,
    pub svg: String,
    pub view_model: String,
}

pub fn parse_micro_app_ideas(input: &str) -> Vec<MicroAppIdea> {
    let mut ideas = Vec::new();
    let parts: Vec<&str> = input.split("<micro-app-idea>").skip(1).collect();

    for part in parts {
        if let Some(end_idx) = part.find("</micro-app-idea>") {
            let content = &part[..end_idx];
            let mut lines = content.lines();

            let title = lines.next().unwrap_or("").trim().to_string();
            let mut spec = String::new();
            let mut svg = String::new();
            let mut view_model = String::new();
            let mut in_svg = false;
            let mut in_model = false;

            for line in lines {
                if line.trim().starts_with("<svg") {
                    in_svg = true;
                }

                if line.trim().starts_with("<view-model") {
                    in_model = true;
                }
                if in_svg {
                    svg.push_str(line);
                    svg.push('\n');
                } else if in_model {
                    view_model.push_str(line);
                    view_model.push('\n');
                } else {
                    spec.push_str(line);
                    spec.push('\n');
                }
                if line.trim().starts_with("</svg>") {
                    in_svg = false;
                }
                if line.trim().starts_with("</view-model>") {
                    in_model = false;
                }
            }

            ideas.push(MicroAppIdea {
                title,
                spec: spec.trim().to_string(),
                svg: svg.trim().to_string(),
                view_model: view_model.trim().to_string(),
            });
        }
    }

    ideas
}

#[component]
pub fn MicroAppGrid(
    input: ReadSignal<String>,
    #[prop(into)] on_save: Callback<()>,
) -> impl IntoView {

    view! {
        <>            
            <div class="micro-app-grid">
                <For
                    each=move || parse_micro_app_ideas(&input.get())
                    key=|idea| idea.title.clone()
                    children=move |idea| {
                        view! {
                            <div class="micro-app-item">
                                <h3 class="micro-app-title">{&idea.title}</h3>
                                <div class="micro-app-spec">
                                    <h4 class="micro-app-spec-title">Spec:</h4>
                                    <div class="micro-app-spec-content">{&idea.spec}</div>
                                </div>
                                <pre>{&idea.view_model}</pre>
                                <div class="micro-app-svg" inner_html=&idea.svg></div>
                                <button on:click=move |_| on_save(())>
                                Click me!
                                </button>
                            </div>
                        }
                    }
                />
            </div>
        </>
    }
}
